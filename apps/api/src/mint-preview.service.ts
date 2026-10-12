import { isRpcTransportFailure } from '@stryx/utils';
import type { WalletService, UserId } from '@stryx/wallet-service';
import { mapWithConcurrency } from './concurrency.js';
import type { ChainServices } from './chain-services.js';
import type { MintExecutionService, AllowListMintRequest, MintFailureReason } from './mint-execution.service.js';

/** Read-only fan-out; bounded for the same reason as MintBatchService's execution pool: see concurrency.ts. */
const PREVIEW_POOL_SIZE = 5;

/** The probe quantity: asks whether a wallet is eligible and what its stage looks like. Never sent. */
const PROBE_QUANTITY = 1;

export type PreviewEligibility = 'eligible' | 'not_eligible' | 'unknown';

export interface WalletPreviewRow {
  walletId: string;
  address: string;
  balanceWei: string;
  /** How many this wallet has already minted on this TOKEN (see SeaDropReader.getMintStats, not stage-scoped). */
  minted: number;
  /** The relevant stage's per-wallet limit, or null if it couldn't be determined (e.g. an OpenSea/RPC read failed). */
  limit: number | null;
  /** max(0, limit - minted), or null when limit is null. */
  remaining: number | null;
  eligible: PreviewEligibility;
  /** A short reason code shown next to `eligible`. */
  reason?: string;
  priceWei: string | null;
}

export interface PreviewRequestBase {
  ownerId: UserId;
  nftContract: `0x${string}`;
  chainId: number;
  walletIds: readonly string[];
}

export type PreviewRequest =
  | (PreviewRequestBase & { stage: 'public' })
  | (PreviewRequestBase & { stage: 'allowlist' } & ({ proofSource: 'opensea'; slug: string } | { proofSource: 'stored'; allowListId: string }));

export interface PreviewOutcome {
  preflightError?: 'unsupported_chain';
  detail?: string;
  results: WalletPreviewRow[];
}

/**
 * Per wallet: can it mint, and how many. Shown before anything is signed, so ineligibility is visible
 * up front instead of as a failed transaction.
 */
export class MintPreviewService {
  constructor(
    private readonly walletService: WalletService,
    private readonly chainServices: Map<number, ChainServices>,
    private readonly mintExecutionService: MintExecutionService,
  ) {}

  async preview(req: PreviewRequest): Promise<PreviewOutcome> {
    const chain = this.chainServices.get(req.chainId);
    if (!chain) {
      return { preflightError: 'unsupported_chain', detail: `chainId=${req.chainId} has no RPC configured.`, results: [] };
    }

    const wallets = await Promise.all(req.walletIds.map((id) => this.walletService.getWalletSummary(req.ownerId, id)));
    const scope = { nftContract: req.nftContract, chainId: req.chainId };

    // Stage-wide reads are the same for every wallet: done once.
    let stageContext: StageContext;
    try {
      if (req.stage === 'public') {
        const [publicDrop, active] = await Promise.all([
          chain.seaDropReader.getPublicDrop(scope),
          chain.seaDropReader.isPublicStageActive(scope),
        ]);
        stageContext = { kind: 'public', limit: publicDrop.maxTotalMintableByWallet, priceWei: publicDrop.mintPrice, active };
      } else {
        stageContext = { kind: 'allowlist', onChainRoot: await chain.seaDropReader.getAllowListMerkleRoot(scope) };
      }
    } catch (err) {
      // A stage-wide read failure affects every wallet the same way: reported once per row.
      const reason = isRpcTransportFailure(err) ? 'rpc_unavailable' : 'read_failed';
      return {
        results: wallets.map((w) => ({
          walletId: w.id,
          address: w.address,
          balanceWei: '0',
          minted: 0,
          limit: null,
          remaining: null,
          eligible: 'unknown',
          reason,
          priceWei: null,
        })),
      };
    }

    const results = await mapWithConcurrency(wallets, PREVIEW_POOL_SIZE, (wallet) =>
      this.previewOne(chain, req, wallet, scope, stageContext),
    );
    return { results };
  }

  private async previewOne(
    chain: ChainServices,
    req: PreviewRequest,
    wallet: { id: string; address: string },
    scope: { nftContract: `0x${string}`; chainId: number },
    stage: StageContext,
  ): Promise<WalletPreviewRow> {
    const address = wallet.address as `0x${string}`;

    // Non-fatal: a failed balance read should not hide the rest of the row.
    let balanceWei = '0';
    try {
      balanceWei = (await chain.publicClient.getBalance({ address })).toString();
    } catch {
      // leave '0': see comment above
    }

    let minted: number;
    try {
      minted = (await chain.seaDropReader.getMintStats(scope, address)).minterNumMinted;
    } catch (err) {
      return {
        walletId: wallet.id,
        address,
        balanceWei,
        minted: 0,
        limit: null,
        remaining: null,
        eligible: 'unknown',
        reason: isRpcTransportFailure(err) ? 'rpc_unavailable' : 'read_failed',
        priceWei: null,
      };
    }

    if (req.stage === 'public' && stage.kind === 'public') {
      const remaining = Math.max(0, stage.limit - minted);
      const eligible: PreviewEligibility = stage.active && remaining > 0 ? 'eligible' : 'not_eligible';
      const reason = !stage.active ? 'stage_not_active' : remaining === 0 ? 'at_mint_limit' : undefined;
      return {
        walletId: wallet.id,
        address,
        balanceWei,
        minted,
        limit: stage.limit,
        remaining,
        eligible,
        ...(reason ? { reason } : {}),
        priceWei: stage.priceWei.toString(),
      };
    }
    if (req.stage !== 'allowlist' || stage.kind !== 'allowlist') {
      // Unreachable; it only lets TypeScript narrow `req` without a cast.
      throw new Error('stage/request mismatch in MintPreviewService.previewOne');
    }

    const probe: AllowListMintRequest =
      req.proofSource === 'opensea'
        ? { ownerId: req.ownerId, walletId: wallet.id, nftContract: req.nftContract, chainId: req.chainId, quantity: PROBE_QUANTITY, proofSource: 'opensea', slug: req.slug }
        : { ownerId: req.ownerId, walletId: wallet.id, nftContract: req.nftContract, chainId: req.chainId, quantity: PROBE_QUANTITY, proofSource: 'stored', allowListId: req.allowListId };

    const resolved = await this.mintExecutionService.resolveAllowListProof(probe, address, stage.onChainRoot);
    if (!resolved.ok) {
      return {
        walletId: wallet.id,
        address,
        balanceWei,
        minted,
        limit: null,
        remaining: null,
        // 'insufficient_funds' means the question could not be asked yet: unknown, not a "no".
        eligible: resolved.reason === 'insufficient_funds' ? 'unknown' : 'not_eligible',
        reason: resolved.reason,
        priceWei: null,
      };
    }

    const limit = resolved.mintParams.maxTotalMintableByWallet;
    const remaining = Math.max(0, limit - minted);
    const reason = remaining === 0 ? 'at_mint_limit' : undefined;
    return {
      walletId: wallet.id,
      address,
      balanceWei,
      minted,
      limit,
      remaining,
      eligible: remaining > 0 ? 'eligible' : 'not_eligible',
      ...(reason ? { reason } : {}),
      priceWei: resolved.mintParams.mintPrice.toString(),
    };
  }
}

type StageContext =
  | { kind: 'public'; limit: number; priceWei: bigint; active: boolean }
  | { kind: 'allowlist'; onChainRoot: `0x${string}` };

// Re-exported so callers need one import.
export type { MintFailureReason };
