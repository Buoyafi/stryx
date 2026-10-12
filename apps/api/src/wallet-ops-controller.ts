import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import { withTimeout, isRpcTransportFailure } from '@stryx/utils';
import type { WalletService, UserId } from '@stryx/wallet-service';
import type { BalanceService } from './balance.service.js';
import type { DisperseService, DisperseRecipient } from './disperse.service.js';
import { chainById } from './chain-registry.js';
import type { AuditLogService } from './audit-log-service.js';
import type { OpenSeaDropInfo } from './opensea-drop-info.js';
import { mapWithConcurrency } from './concurrency.js';
import type { NftHoldingsService } from './nft-holdings.service.js';
import type { NftTransferService, NftTransferItem } from './nft-transfer.service.js';
import { credentialActorType } from './audit-actor.js';

/** Per-read budget for the receipt lookup: same 8s precedent as BalanceService and the mint-path chain reads. */
const RECEIPT_TIMEOUT_MS = 8_000;
/** How many receipts a batch lookup fetches concurrently: see concurrency.ts. */
const RECEIPT_BATCH_POOL_SIZE = 8;
const MAX_RECEIPT_BATCH = 50;
/** How many wallets' balances are fetched at once. */
const BALANCE_BATCH_POOL_SIZE = 5;
/** How many wallets' nonces are warmed at once. */
const WARM_NONCE_POOL_SIZE = 8;
const MAX_WARM_NONCE_BATCH = 100;

const AddressField = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte address');
// Amounts arrive as decimal strings, never floats, which lose precision.
const AmountField = z.string().regex(/^\d+(\.\d+)?$/, 'must be a decimal amount string, e.g. "0.01"');

const WarmNoncesInputSchema = z.object({
  walletIds: z.array(z.string().min(1)).min(1).max(MAX_WARM_NONCE_BATCH),
});

const DisperseInputSchema = z.object({
  sourceWalletId: z.string().min(1),
  chainId: z.number().int().positive(),
  recipients: z
    .array(z.object({ address: AddressField, amount: AmountField }))
    .min(1, 'at least one recipient required')
    .max(100, 'max 100 recipients per batch'),
});

// A tokenId/amount travels as a decimal string: both routinely exceed JS's safe-integer range.
const TokenIdField = z.string().regex(/^\d+$/, 'must be a decimal tokenId string');
const TokenAmountField = z.string().regex(/^\d+$/, 'must be a decimal amount string');

const NftTransferInputSchema = z.object({
  chainId: z.number().int().positive(),
  destination: AddressField,
  items: z
    .array(
      z.object({
        walletId: z.string().min(1),
        contract: AddressField,
        tokenId: TokenIdField,
        standard: z.enum(['erc721', 'erc1155']),
        amount: TokenAmountField.default('1'),
      }),
    )
    .min(1, 'at least one item required')
    .max(100, 'max 100 items per batch'),
});

/** The audit line for a disperse. */
export function disperseAuditDetail(chainId: number, outcome: { haltReason?: string; totalSentWei: string; results: readonly { status: string; hash?: string }[] }): string {
  const broadcast = outcome.results.filter((r) => r.status === 'sent').length;
  const unknown = outcome.results.filter((r) => r.status === 'unknown').length;
  const hashes = outcome.results.flatMap((r) => (r.hash ? [r.hash] : []));
  const shown = hashes.slice(0, 5).join(' ');
  return [
    outcome.haltReason ? `${outcome.haltReason}: ` : '',
    `chain ${chainId}: broadcast ${broadcast} of ${outcome.results.length} transfer(s), ${outcome.totalSentWei} wei`,
    unknown > 0 ? `, ${unknown} outcome unknown` : '',
    hashes.length > 0 ? `; hashes ${shown}${hashes.length > 5 ? ` and ${hashes.length - 5} more` : ''}` : '',
  ].join('');
}

export interface WalletOpsControllerDeps {
  walletService: WalletService;
  balanceService: BalanceService;
  disperseService: DisperseService;
  /** Chain ids actually configured on this instance, for the UI's chain picker. */
  configuredChainIds: number[];
  /** Full chain services, for reading live drop state. */
  chainServicesMap: Map<number, import('./chain-services.js').ChainServices>;
  /** Resolves the caller's owner id (ADR-002 §3.3): see wallet.controller.ts's dep of the same name. */
  resolveOwnerId: (request: FastifyRequest) => UserId;
  /** ADR-002 §3.10. Optional so tests that don't care about audit logging don't need it wired up. */
  auditLogService?: AuditLogService;
  /** Optional. When present, GET /wallets/:id/nfts is registered. */
  nftHoldingsService?: NftHoldingsService;
  /** Optional. When present, POST /wallets/nfts/transfer is registered. */
  nftTransferService?: NftTransferService;
  /** Best-effort OpenSea enrichment for the drop-detail route. */
  fetchOpenSeaDropInfo?: (chainId: number, contract: string) => Promise<OpenSeaDropInfo | null>;
}

/** Wallet operations beyond basic CRUD: native balances across chains, and dispersing native tokens from one wallet to many. */
export const walletOpsController: (deps: WalletOpsControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerWalletOpsRoutes(app: FastifyInstance) {
    // Which chains this instance can operate on, with display names.
    app.get('/chains', async (_request, reply) => {
      const chains = deps.configuredChainIds.map((chainId) => ({
        chainId,
        name: chainById(chainId)?.name ?? `Chain ${chainId}`,
      }));
      return reply.send({ chains });
    });

    // Has a sent transaction been mined yet?
    app.get('/chains/:chainId/transactions/:hash', async (request, reply) => {
      const params = z
        .object({
          chainId: z.coerce.number().int().positive(),
          hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte transaction hash'),
        })
        .parse(request.params);

      const chain = deps.chainServicesMap.get(params.chainId);
      if (!chain) {
        return reply.code(400).send({
          error: 'unsupported_chain',
          message: `chainId=${params.chainId} has no RPC configured on this instance.`,
        });
      }

      try {
        const receipt = await withTimeout(
          chain.publicClient.getTransactionReceipt({ hash: params.hash as `0x${string}` }),
          RECEIPT_TIMEOUT_MS,
          'transaction receipt read',
        );
        return reply.send({
          chainId: params.chainId,
          hash: params.hash,
          status: receipt.status === 'success' ? 'success' : 'reverted',
          blockNumber: receipt.blockNumber.toString(),
          // Only known once mined.
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
        });
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) {
          return reply.send({ chainId: params.chainId, hash: params.hash, status: 'pending' });
        }
        if (isRpcTransportFailure(err)) {
          // A static message: viem's own error text embeds the RPC URL and its key.
          return reply.code(502).send({
            error: 'rpc_unavailable',
            message: 'Could not reach the chain to check this transaction.',
          });
        }
        throw err;
      }
    });

    // The same lookup for up to MAX_RECEIPT_BATCH hashes at once, so a results table polls in one
    // request.
    app.post('/chains/:chainId/transactions/receipts', async (request, reply) => {
      const params = z.object({ chainId: z.coerce.number().int().positive() }).parse(request.params);
      const { hashes, lookup } = z
        .object({
          hashes: z
            .array(z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte transaction hash'))
            .min(1)
            .max(MAX_RECEIPT_BATCH),
          // Also ask whether the chain still has a transaction that has no receipt: 'pending' if it
          // does, 'not_found' if not.
          lookup: z.boolean().optional(),
        })
        .parse(request.body);

      const chain = deps.chainServicesMap.get(params.chainId);
      if (!chain) {
        return reply.code(400).send({
          error: 'unsupported_chain',
          message: `chainId=${params.chainId} has no RPC configured on this instance.`,
        });
      }

      const receipts = await mapWithConcurrency(hashes, RECEIPT_BATCH_POOL_SIZE, async (hash) => {
        try {
          const receipt = await withTimeout(
            chain.publicClient.getTransactionReceipt({ hash: hash as `0x${string}` }),
            RECEIPT_TIMEOUT_MS,
            'transaction receipt read',
          );
          return {
            hash,
            status: receipt.status === 'success' ? ('success' as const) : ('reverted' as const),
            blockNumber: receipt.blockNumber.toString(),
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
          };
        } catch (err) {
          if (err instanceof TransactionReceiptNotFoundError) {
            if (!lookup) return { hash, status: 'pending' as const };
            try {
              await withTimeout(chain.publicClient.getTransaction({ hash: hash as `0x${string}` }), RECEIPT_TIMEOUT_MS, 'transaction read');
              return { hash, status: 'pending' as const };
            } catch (lookupErr) {
              // Only the node's own "no such transaction" counts: a read that failed proves nothing.
              return { hash, status: lookupErr instanceof TransactionNotFoundError ? ('not_found' as const) : ('pending' as const) };
            }
          }
          // A transport failure for one hash does not fail the batch: it is reported for that hash,
          // without the raw message.
          return {
            hash,
            status: 'unknown' as const,
            error: isRpcTransportFailure(err) ? 'Could not reach the chain to check this transaction.' : 'Unexpected error checking this transaction.',
          };
        }
      });

      return reply.send({ chainId: params.chainId, receipts });
    });

    // Pays each wallet's one-time nonce read ahead of the real mint. Called when the mint review
    // screen opens.
    app.post('/chains/:chainId/wallets/warm-nonces', async (request, reply) => {
      const params = z.object({ chainId: z.coerce.number().int().positive() }).parse(request.params);
      const { walletIds } = WarmNoncesInputSchema.parse(request.body);

      const chain = deps.chainServicesMap.get(params.chainId);
      if (!chain) {
        return reply.code(400).send({
          error: 'unsupported_chain',
          message: `chainId=${params.chainId} has no RPC configured on this instance.`,
        });
      }

      const ownerId = deps.resolveOwnerId(request);
      const wallets = await Promise.all(walletIds.map((id) => deps.walletService.getWalletSummary(ownerId, id)));

      const outcomes = await mapWithConcurrency(wallets, WARM_NONCE_POOL_SIZE, async (w) => {
        try {
          await chain.transactionEngine.warmNonce({ chainId: params.chainId, walletAddress: w.address as `0x${string}` });
          return true;
        } catch {
          return false;
        }
      });

      return reply.send({ warmed: outcomes.filter(Boolean).length });
    });

    // Live on-chain state for a drop: is the public stage open, at what price, and is an allow-list
    // configured.
    app.get('/drops/:chainId/:contract', async (request, reply) => {
      const params = z
        .object({ chainId: z.coerce.number().int().positive(), contract: AddressField })
        .parse(request.params);

      const chain = deps.chainServicesMap.get(params.chainId);
      if (!chain) {
        return reply.code(400).send({
          error: 'unsupported_chain',
          message: `chainId=${params.chainId} has no RPC configured on this instance.`,
        });
      }

      const scope = { nftContract: params.contract as `0x${string}`, chainId: params.chainId };

      try {
        const [publicDrop, publicActive, allowListRoot, feeRecipients] = await Promise.all([
          chain.seaDropReader.getPublicDrop(scope),
          chain.seaDropReader.isPublicStageActive(scope),
          chain.seaDropReader.getAllowListMerkleRoot(scope),
          chain.seaDropReader.getAllowedFeeRecipients(scope),
        ]);

        const ZERO_ROOT = `0x${'00'.repeat(32)}`;

        // Best effort, never blocking: the on-chain data is a complete answer by itself, and OpenSea
        // only adds display context.
        const openSea = (await deps.fetchOpenSeaDropInfo?.(params.chainId, params.contract).catch(() => null)) ?? null;

        return reply.send({
          contract: params.contract,
          chainId: params.chainId,
          publicStage: {
            configured: publicDrop.startTime !== 0,
            active: publicActive,
            mintPriceWei: publicDrop.mintPrice.toString(),
            startTime: publicDrop.startTime,
            endTime: publicDrop.endTime,
            maxPerWallet: publicDrop.maxTotalMintableByWallet,
            feeBps: publicDrop.feeBps,
          },
          allowList: {
            configured: allowListRoot.toLowerCase() !== ZERO_ROOT,
            merkleRoot: allowListRoot,
          },
          feeRecipients,
          openSea,
        });
      } catch (err) {
        // A contract that isn't a SeaDrop drop (or an RPC failure) lands here.
        return reply.code(502).send({
          error: 'drop_read_failed',
          message: err instanceof Error ? err.message : 'Could not read drop state from chain.',
        });
      }
    });

    // Native balances for every wallet on one chain.
    app.get('/wallets/balances', async (request, reply) => {
      const { chainId } = z.object({ chainId: z.coerce.number().int().positive() }).parse(request.query);

      const chain = deps.chainServicesMap.get(chainId);
      if (!chain) {
        return reply.code(400).send({
          error: 'unsupported_chain',
          message: `chainId=${chainId} has no RPC configured on this instance.`,
        });
      }

      const wallets = await deps.walletService.listWallets(deps.resolveOwnerId(request));

      // Bounded concurrency, one chain per wallet: an unbounded fan-out across every wallet and every
      // chain floods the RPC and times out.
      const balances = await mapWithConcurrency(wallets, BALANCE_BATCH_POOL_SIZE, async (w) => {
        const forChain = await deps.balanceService.getBalanceOn(w.address as `0x${string}`, chainId);
        return {
          walletId: w.id,
          address: w.address,
          wei: forChain.wei,
          formatted: forChain.formatted,
          ...(forChain.error ? { error: forChain.error } : {}),
        };
      });

      return reply.send({ chainId, balances });
    });

    // Native balances for one wallet, on every configured chain or on one (`?chainId=`).
    app.get('/wallets/:id/balances', async (request, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const { chainId } = z.object({ chainId: z.coerce.number().int().positive().optional() }).parse(request.query);
      const wallet = await deps.walletService.getWalletSummary(deps.resolveOwnerId(request), id);
      const address = wallet.address as `0x${string}`;
      const balances = chainId === undefined ? await deps.balanceService.getBalances(address) : [await deps.balanceService.getBalanceOn(address, chainId)];
      return reply.send({ walletId: id, address: wallet.address, balances });
    });

    // Disperse native tokens from one wallet to many.
    app.post('/wallets/disperse', async (request, reply) => {
      const input = DisperseInputSchema.parse(request.body);
      const ownerId = deps.resolveOwnerId(request);

      const outcome = await deps.disperseService.disperse({
        ownerId,
        sourceWalletId: input.sourceWalletId,
        chainId: input.chainId,
        recipients: input.recipients as readonly DisperseRecipient[],
      });

      // Pre-flight rejections mean NOTHING was sent: a clean 4xx.
      if (outcome.preflightError) {
        await deps.auditLogService?.record({
          actorUserId: ownerId,
          actorType: credentialActorType(request),
          action: 'disperse',
          walletId: input.sourceWalletId,
          outcome: 'failure',
          detail: `${outcome.preflightError}: ${outcome.detail}`,
        });
        const status = outcome.preflightError === 'unsupported_chain' || outcome.preflightError === 'zero_amount' ? 400 : outcome.preflightError === 'chain_unreachable' ? 503 : 409;
        return reply.code(status).send({
          error: outcome.preflightError,
          message: outcome.detail,
          results: [],
        });
      }

      await deps.auditLogService?.record({
        actorUserId: ownerId,
        actorType: credentialActorType(request),
        action: 'disperse',
        walletId: input.sourceWalletId,
        outcome: outcome.ok ? 'success' : 'failure',
        // Why a batch halted early belongs in the audit record, not only the HTTP response.
        detail: disperseAuditDetail(input.chainId, outcome),
      });

      // Past pre-flight, transfers were attempted: 200 with the per-recipient detail.
      return reply.code(200).send(outcome);
    });

    // What one wallet holds on one chain, per NftHoldingsService: a live indexer when one is
    // configured for the chain, the mint ledger otherwise.
    if (deps.nftHoldingsService) {
      const nftHoldingsService = deps.nftHoldingsService;
      app.get('/wallets/:id/nfts', async (request, reply) => {
        const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
        const { chainId } = z.object({ chainId: z.coerce.number().int().positive() }).parse(request.query);
        const ownerId = deps.resolveOwnerId(request);
        const result = await nftHoldingsService.listHoldings(ownerId, id, chainId);
        return reply.send({ walletId: id, chainId, ...result });
      });
    }

    // Moves NFTs out of one or more of our wallets to a single destination.
    if (deps.nftTransferService) {
      const nftTransferService = deps.nftTransferService;
      app.post('/wallets/nfts/transfer', async (request, reply) => {
        const input = NftTransferInputSchema.parse(request.body);
        const ownerId = deps.resolveOwnerId(request);

        const outcome = await nftTransferService.transfer({
          ownerId,
          chainId: input.chainId,
          destination: input.destination as `0x${string}`,
          items: input.items as readonly NftTransferItem[],
        });

        if (outcome.preflightError) {
          await deps.auditLogService?.record({
            actorUserId: ownerId,
            actorType: credentialActorType(request),
            action: 'nft.transfer',
            outcome: 'failure',
            detail: `${outcome.preflightError}: ${outcome.detail}`,
          });
          const status = outcome.preflightError === 'unsupported_chain' ? 400 : 409;
          return reply.code(status).send({ error: outcome.preflightError, message: outcome.detail, results: [] });
        }

        await deps.auditLogService?.record({
          actorUserId: ownerId,
          actorType: credentialActorType(request),
          action: 'nft.transfer',
          outcome: outcome.ok ? 'success' : 'failure',
          detail: outcome.haltReason
            ? `${outcome.haltReason}: ${outcome.results.length} item(s) attempted`
            : `${outcome.results.length} item(s) attempted`,
        });

        // Past pre-flight, transfers were attempted: 200 with the per-item detail.
        return reply.code(200).send(outcome);
      });
    }
  };
