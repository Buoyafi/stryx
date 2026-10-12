import type { MintEventSource } from './mint-event-log.js';
import { withTimeout, isRpcTransportFailure, TimeoutBudgetExceededError } from '@stryx/utils';
import type { WalletService, UserId } from '@stryx/wallet-service';
import type { ChainServices } from './chain-services.js';
import { SEND_UNCONFIRMED_MESSAGE, type MintExecutionService, type AllowListMintRequest, type MintFailureReason } from './mint-execution.service.js';

/** Caps how many wallets one batch can touch. */
export const MAX_BATCH_WALLETS = 25;

/** The most one mint may ask for. 'max' resolves to no more than this, same as a typed quantity. */
export const MAX_QUANTITY_PER_MINT = 50;

/** How many wallets mint concurrently: see the class doc for why this is bounded, and why it isn't 1 or unbounded. */
const EXECUTION_POOL_SIZE = 4;

/** Upper bound on a single wallet's mint. Every chain read inside it has its own timeout; this covers the whole path. */
const PER_WALLET_MINT_TIMEOUT_MS = 30_000;

export type BatchQuantity = number | 'max';

interface BatchMintRequestBase {
  ownerId: UserId;
  nftContract: `0x${string}`;
  chainId: number;
  walletIds: readonly string[];
  /**
   * A fixed quantity is sent for every wallet as given, including one already at its limit, which
   * reverts on chain instead of being skipped.
   */
  quantity: BatchQuantity;
  /** The priority fee (tip) in wei for every wallet's mint; unset means the node's suggestion. */
  priorityFeeWei?: string;
  /** For the mint log: who asked (see PublicMintRequest.source). */
  source?: MintEventSource;
}

export type BatchMintRequest =
  | (BatchMintRequestBase & { stage: 'public' })
  | (BatchMintRequestBase & { stage: 'allowlist' } & (
      | { proofSource: 'opensea'; slug: string }
      | { proofSource: 'stored'; allowListId: string }
      // 'direct' is excluded: a pasted proof belongs to the one wallet it was made for.
    ));

export type BatchHaltReason = 'spending_cap_exceeded' | 'emergency_stop' | 'rpc_unavailable';

/** Reasons that halt the batch: each means every remaining wallet would hit the same wall. */
const HALTING_REASONS = new Set<MintFailureReason>(['emergency_stop', 'spending_cap_exceeded', 'rpc_unavailable']);

export interface WalletMintRow {
  walletId: string;
  address: string;
  /** 'unknown': the mint may have gone out (a send that never answered, or a timeout). Never retry it blind. */
  status: 'sent' | 'failed' | 'skipped' | 'unknown';
  /** The quantity actually attempted, for 'max' mode this varies per wallet; 0 for a skipped, already-at-limit wallet. */
  quantity: number;
  hash?: `0x${string}`;
  nonce?: number;
  reason?: MintFailureReason | 'at_mint_limit';
  error?: string;
}

export interface BatchMintOutcome {
  ok: boolean;
  /** Set when the WHOLE batch was rejected before any wallet was touched. */
  preflightError?: 'unsupported_chain' | 'no_wallets' | 'duplicate_wallets' | 'too_many_wallets';
  detail?: string;
  /** Set when the batch was halted partway through: mirrors DisperseOutcome.haltReason. */
  haltReason?: BatchHaltReason;
  results: WalletMintRow[];
}

/**
 * Mints one drop from several wallets at once. Wallets run concurrently, each through the same path as
 * a single mint, and one wallet's failure never fails another's.
 */
export class MintBatchService {
  constructor(
    private readonly walletService: WalletService,
    private readonly chainServices: Map<number, ChainServices>,
    private readonly mintExecutionService: MintExecutionService,
    private readonly poolSize = EXECUTION_POOL_SIZE,
    private readonly perWalletTimeoutMs = PER_WALLET_MINT_TIMEOUT_MS,
  ) {}

  async mint(req: BatchMintRequest): Promise<BatchMintOutcome> {
    if (req.walletIds.length === 0) {
      return { ok: false, preflightError: 'no_wallets', results: [] };
    }
    if (new Set(req.walletIds).size !== req.walletIds.length) {
      return { ok: false, preflightError: 'duplicate_wallets', detail: 'The same wallet was selected more than once.', results: [] };
    }
    if (req.walletIds.length > MAX_BATCH_WALLETS) {
      return { ok: false, preflightError: 'too_many_wallets', detail: `A batch is limited to ${MAX_BATCH_WALLETS} wallets.`, results: [] };
    }

    const chain = this.chainServices.get(req.chainId);
    if (!chain) {
      return { ok: false, preflightError: 'unsupported_chain', detail: `chainId=${req.chainId} has no RPC configured.`, results: [] };
    }

    const wallets = await Promise.all(req.walletIds.map((id) => this.walletService.getWalletSummary(req.ownerId, id)));
    const scope = { nftContract: req.nftContract, chainId: req.chainId };

    // 'max' needs the stage's per-wallet limit, the same for every wallet: read once here.
    let resolveCtx: { publicLimit?: number; onChainRoot?: `0x${string}` } = {};
    if (req.quantity === 'max') {
      try {
        resolveCtx =
          req.stage === 'public'
            ? { publicLimit: (await chain.seaDropReader.getPublicDrop(scope)).maxTotalMintableByWallet }
            : { onChainRoot: await chain.seaDropReader.getAllowListMerkleRoot(scope) };
      } catch (err) {
        if (!isRpcTransportFailure(err)) throw err; // genuinely unexpected: fail loud, don't mislabel it
        // A static message: viem's own error text embeds the RPC URL.
        const message = 'Could not reach the chain to resolve "max" mint quantities.';
        return {
          ok: false,
          haltReason: 'rpc_unavailable',
          results: wallets.map((w) => ({ walletId: w.id, address: w.address, status: 'skipped', quantity: 0, reason: 'rpc_unavailable', error: message })),
        };
      }
    }

    const results: WalletMintRow[] = new Array(wallets.length);
    let halted: BatchHaltReason | undefined;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= wallets.length) return;
        const wallet = wallets[i]!;

        if (halted) {
          results[i] = { walletId: wallet.id, address: wallet.address, status: 'skipped', quantity: 0, reason: halted, error: haltMessage(halted) };
          continue;
        }

        const row = await this.mintOne(chain, req, wallet, scope, resolveCtx);
        results[i] = row;
        if (row.status === 'failed' && row.reason && HALTING_REASONS.has(row.reason as MintFailureReason)) {
          halted ??= row.reason as BatchHaltReason;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.poolSize, wallets.length) }, worker));

    return { ok: results.every((r) => r.status === 'sent'), ...(halted ? { haltReason: halted } : {}), results };
  }

  private async mintOne(
    chain: ChainServices,
    req: BatchMintRequest,
    wallet: { id: string; address: string },
    scope: { nftContract: `0x${string}`; chainId: number },
    resolveCtx: { publicLimit?: number; onChainRoot?: `0x${string}` },
  ): Promise<WalletMintRow> {
    const address = wallet.address as `0x${string}`;
    let quantity: number;

    if (req.quantity === 'max') {
      try {
        const minted = (await chain.seaDropReader.getMintStats(scope, address)).minterNumMinted;
        let limit: number;
        if (req.stage === 'public') {
          limit = resolveCtx.publicLimit!;
        } else {
          const probe: AllowListMintRequest =
            req.proofSource === 'opensea'
              ? { ownerId: req.ownerId, walletId: wallet.id, nftContract: req.nftContract, chainId: req.chainId, quantity: 1, proofSource: 'opensea', slug: req.slug }
              : { ownerId: req.ownerId, walletId: wallet.id, nftContract: req.nftContract, chainId: req.chainId, quantity: 1, proofSource: 'stored', allowListId: req.allowListId };
          const resolved = await this.mintExecutionService.resolveAllowListProof(probe, address, resolveCtx.onChainRoot!);
          if (!resolved.ok) {
            return { walletId: wallet.id, address, status: 'failed', quantity: 0, reason: resolved.reason, error: resolved.detail ?? resolved.reason };
          }
          limit = resolved.mintParams.maxTotalMintableByWallet;
        }
        quantity = Math.min(MAX_QUANTITY_PER_MINT, Math.max(0, limit - minted));
      } catch (err) {
        // A per-wallet read can also fail as a raw transport error, whose message embeds the RPC URL.
        return {
          walletId: wallet.id,
          address,
          status: 'failed',
          quantity: 0,
          ...(isRpcTransportFailure(err) ? { reason: 'rpc_unavailable' as const } : {}),
          error: isRpcTransportFailure(err) ? 'Could not reach the chain to resolve this wallet\'s "max" quantity.' : err instanceof Error ? err.message : String(err),
        };
      }

      if (quantity === 0) {
        return { walletId: wallet.id, address, status: 'skipped', quantity: 0, reason: 'at_mint_limit', error: `Already at this wallet's per-wallet mint limit.` };
      }
    } else {
      quantity = req.quantity;
    }

    const tip = { ...(req.priorityFeeWei ? { priorityFeeWei: req.priorityFeeWei } : {}), ...(req.source ? { source: req.source } : {}) };
    let outcome;
    try {
      outcome = await withTimeout(
        req.stage === 'public'
          ? this.mintExecutionService.executePublicMint({ ownerId: req.ownerId, walletId: wallet.id, nftContract: req.nftContract, chainId: req.chainId, quantity, ...tip })
          : this.mintExecutionService.executeAllowListMint(
              req.proofSource === 'opensea'
                ? { ownerId: req.ownerId, walletId: wallet.id, nftContract: req.nftContract, chainId: req.chainId, quantity, ...tip, proofSource: 'opensea', slug: req.slug }
                : { ownerId: req.ownerId, walletId: wallet.id, nftContract: req.nftContract, chainId: req.chainId, quantity, ...tip, proofSource: 'stored', allowListId: req.allowListId },
            ),
        this.perWalletTimeoutMs,
        `mint for wallet=${wallet.id}`,
      );
    } catch (err) {
      // A timeout, or any unexpected throw, fails this wallet's row only.
      if (err instanceof TimeoutBudgetExceededError) {
        return { walletId: wallet.id, address, status: 'unknown', quantity, reason: 'send_unconfirmed', error: `Timed out. ${SEND_UNCONFIRMED_MESSAGE}` };
      }
      return {
        walletId: wallet.id,
        address,
        status: 'failed',
        quantity,
        error: isRpcTransportFailure(err) ? 'Could not reach the chain for this wallet\'s mint.' : err instanceof Error ? err.message : String(err),
      };
    }

    if (outcome.ok) {
      return { walletId: wallet.id, address, status: 'sent', quantity, hash: outcome.result.hash, nonce: outcome.result.nonce };
    }
    if (outcome.reason === 'send_unconfirmed') {
      return { walletId: wallet.id, address, status: 'unknown', quantity, reason: outcome.reason, error: outcome.detail ?? SEND_UNCONFIRMED_MESSAGE, ...(outcome.hash ? { hash: outcome.hash } : {}), ...(outcome.nonce !== undefined ? { nonce: outcome.nonce } : {}) };
    }
    return { walletId: wallet.id, address, status: 'failed', quantity, reason: outcome.reason, error: outcome.detail ?? outcome.reason };
  }
}

function haltMessage(reason: BatchHaltReason): string {
  switch (reason) {
    case 'emergency_stop':
      return 'Skipped: emergency stop halted the batch';
    case 'spending_cap_exceeded':
      return 'Skipped: daily spending cap reached';
    case 'rpc_unavailable':
      return 'Skipped: chain was unreachable';
  }
}
