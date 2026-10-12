import { isRpcTransportFailure, isInsufficientFundsFailure } from '@stryx/utils';
import type { WalletService, UserId } from '@stryx/wallet-service';
import { SeaDropTransactionBuilder, decodeSeaDropRevertData, type UnsignedTransactionRequest } from '@stryx/nft-engine';
import { TransactionSimulator, SimulationRevertedError, RpcUnavailableError } from '@stryx/transaction-engine';
import { mapWithConcurrency } from './concurrency.js';
import type { ChainServices } from './chain-services.js';
import type { MintExecutionService, AllowListMintRequest } from './mint-execution.service.js';
import type { OpenSeaEligibilitySource } from './opensea-eligibility-source.js';
import type { Phase } from './collection-phases.service.js';

const POOL_SIZE = 5;
/** A stage's parameters do not vary by quantity, and 1 is the smallest valid probe. */
const PROBE_QUANTITY = 1;

/**
 * OpenSea's two endpoints format the same stage id differently (with and without hyphens), so ids are
 * compared with hyphens stripped and case folded.
 */
function normalizeStageUuid(uuid: string | null): string {
  return uuid ? uuid.replace(/-/g, '').toLowerCase() : '';
}

/** A short reason for a failed live check. The raw chain error names the wallet id and the RPC URL, so it stays here. */
function simulationFailureReason(err: unknown): string {
  if (isInsufficientFundsFailure(err)) return 'insufficient_funds';
  if (err instanceof RpcUnavailableError) return 'rpc_unavailable';
  if (err instanceof SimulationRevertedError && err.revertData) return decodeSeaDropRevertData(err.revertData) ?? 'reverted';
  return 'reverted';
}

export type WalletEligibility = 'eligible' | 'not_eligible' | 'unknown';

export interface WalletEligibilityRow {
  walletId: string;
  address: string;
  balanceWei: string;
  /** How many this wallet has minted on this token (not per stage): the counter every per-wallet limit is checked against. */
  minted: number;
  limit: number | null;
  remaining: number | null;
  eligible: WalletEligibility;
  /**
   * A short reason code: 'not_on_allowlist', 'at_mint_limit', 'stage_not_active', a MintFailureReason,
   * or an RPC or OpenSea failure code.
   */
  reason?: string;
  priceWei: string | null;
  /**
   * An eth_call simulation of the actual mint, attempted only once the wallet is eligible and the
   * phase is live. Absent when it was never attempted, which is always the case for a signed stage. A
   * failure's reason is 'insufficient_funds', 'rpc_unavailable', the decoded SeaDrop error, or
   * 'reverted'.
   */
  simulation?: { ok: true } | { ok: false; reason: string };
}

export interface PhaseEligibilityOutcome {
  preflightError?: 'unsupported_chain' | 'unsupported_mechanism' | 'missing_slug' | 'signed_mint_disabled';
  detail?: string;
  results: WalletEligibilityRow[];
}

export interface CheckPhaseParams {
  ownerId: UserId;
  nftContract: `0x${string}`;
  chainId: number;
  phase: Phase;
  /** The collection's OpenSea slug. Null when the collection has no OpenSea listing: then only a public phase can be checked. */
  slug: string | null;
  walletIds: readonly string[];
}

/**
 * Per-wallet, per-phase eligibility: resolve what the wallet is entitled to (a proof, a signed answer
 * or the public limit), verify it against the chain, then simulate the real mint once the phase is
 * live. Read-only: nothing is signed or sent.
 */
export class MintEligibilityService {
  private readonly builder = new SeaDropTransactionBuilder();

  constructor(
    private readonly walletService: WalletService,
    private readonly chainServices: Map<number, ChainServices>,
    private readonly mintExecutionService: MintExecutionService,
    /** Null when signed-stage eligibility is off, or its optional module is not installed. */
    private readonly openSeaEligibility: OpenSeaEligibilitySource | null,
    private readonly now: () => number = Date.now,
  ) {}

  async checkPhase(params: CheckPhaseParams): Promise<PhaseEligibilityOutcome> {
    const chain = this.chainServices.get(params.chainId);
    if (!chain) return { preflightError: 'unsupported_chain', detail: `chainId=${params.chainId} has no RPC configured.`, results: [] };

    const wallets = await Promise.all(params.walletIds.map((id) => this.walletService.getWalletSummary(params.ownerId, id)));
    const scope = { nftContract: params.nftContract, chainId: params.chainId };

    if (params.phase.kind === 'public') {
      return { results: await mapWithConcurrency(wallets, POOL_SIZE, (w) => this.checkPublicOne(chain, scope, w)) };
    }

    if (params.phase.mechanism === 'merkle') {
      if (!params.slug) return { preflightError: 'missing_slug', detail: 'This collection has no OpenSea listing, so its Merkle allow-list proof cannot be fetched.', results: [] };
      return { results: await mapWithConcurrency(wallets, POOL_SIZE, (w) => this.checkMerkleOne(chain, scope, params, w)) };
    }

    if (params.phase.mechanism === 'signed') {
      if (!this.openSeaEligibility) {
        return {
          preflightError: 'signed_mint_disabled',
          detail: 'Signed-mint eligibility checks are turned off on this instance (OPENSEA_SIGNED_MINT_ELIGIBILITY_ENABLED). Ask an operator to enable it.',
          results: [],
        };
      }
      if (!params.slug || !params.phase.openSeaStageUuid) return { preflightError: 'missing_slug', detail: 'This phase has no OpenSea stage id, so its signed-mint eligibility cannot be checked.', results: [] };
      const source = this.openSeaEligibility;
      return { results: await mapWithConcurrency(wallets, POOL_SIZE, (w) => this.checkSignedOne(chain, scope, params, w, source)) };
    }

    // Token-gated or unknown: fail clearly, never apply another mechanism's logic.
    return {
      preflightError: 'unsupported_mechanism',
      detail: `No eligibility check is implemented for mechanism "${params.phase.mechanism}".`,
      results: wallets.map((w) => this.unknownRow(w, `unsupported_mechanism:${params.phase.mechanism}`)),
    };
  }

  private unknownRow(wallet: { id: string; address: string }, reason: string): WalletEligibilityRow {
    return { walletId: wallet.id, address: wallet.address, balanceWei: '0', minted: 0, limit: null, remaining: null, eligible: 'unknown', reason, priceWei: null };
  }

  private async balanceOf(chain: ChainServices, address: `0x${string}`): Promise<string> {
    try {
      return (await chain.publicClient.getBalance({ address })).toString();
    } catch {
      return '0'; // non-fatal: see MintPreviewService.previewOne's identical reasoning
    }
  }

  private async simulate(chain: ChainServices, wallet: { id: string; address: string }, chainId: number, tx: UnsignedTransactionRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
    const simulator = new TransactionSimulator(chain.publicClient);
    try {
      await simulator.simulate({ chainId, walletId: wallet.id, walletAddress: wallet.address, ownerId: 'n/a', spendCapWei: null }, tx);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: simulationFailureReason(err) };
    }
  }

  private async checkPublicOne(chain: ChainServices, scope: { nftContract: `0x${string}`; chainId: number }, wallet: { id: string; address: string }): Promise<WalletEligibilityRow> {
    const address = wallet.address as `0x${string}`;
    const balanceWei = await this.balanceOf(chain, address);

    let minted: number;
    try {
      minted = (await chain.seaDropReader.getMintStats(scope, address)).minterNumMinted;
    } catch (err) {
      return { ...this.unknownRow(wallet, isRpcTransportFailure(err) ? 'rpc_unavailable' : 'read_failed'), balanceWei };
    }

    let publicDrop, active: boolean;
    try {
      [publicDrop, active] = await Promise.all([chain.seaDropReader.getPublicDrop(scope), chain.seaDropReader.isPublicStageActive(scope)]);
    } catch (err) {
      return { ...this.unknownRow(wallet, isRpcTransportFailure(err) ? 'rpc_unavailable' : 'read_failed'), balanceWei, minted };
    }

    const limit = publicDrop.maxTotalMintableByWallet;
    const remaining = Math.max(0, limit - minted);
    // `eligible` answers "may this wallet mint", never "is the stage live": an upcoming phase still
    // shows which wallets can be selected. `active` only gates the simulation.
    const row: WalletEligibilityRow = {
      walletId: wallet.id,
      address,
      balanceWei,
      minted,
      limit,
      remaining,
      eligible: remaining > 0 ? 'eligible' : 'not_eligible',
      ...(remaining === 0 ? { reason: 'at_mint_limit' } : !active ? { reason: 'stage_not_active' } : {}),
      priceWei: publicDrop.mintPrice.toString(),
    };

    if (remaining === 0 || !active) return row;
    const feeRecipient = (await chain.seaDropReader.getAllowedFeeRecipients(scope))[0];
    if (!feeRecipient) return row;
    const tx = this.builder.buildMintPublicTx(scope, feeRecipient, PROBE_QUANTITY, publicDrop.mintPrice);
    return { ...row, simulation: await this.simulate(chain, wallet, scope.chainId, tx) };
  }

  private async checkMerkleOne(chain: ChainServices, scope: { nftContract: `0x${string}`; chainId: number }, params: CheckPhaseParams, wallet: { id: string; address: string }): Promise<WalletEligibilityRow> {
    const address = wallet.address as `0x${string}`;
    const balanceWei = await this.balanceOf(chain, address);

    let minted: number;
    try {
      minted = (await chain.seaDropReader.getMintStats(scope, address)).minterNumMinted;
    } catch (err) {
      return { ...this.unknownRow(wallet, isRpcTransportFailure(err) ? 'rpc_unavailable' : 'read_failed'), balanceWei };
    }

    let onChainRoot: `0x${string}`;
    try {
      onChainRoot = await chain.seaDropReader.getAllowListMerkleRoot(scope);
    } catch (err) {
      return { ...this.unknownRow(wallet, isRpcTransportFailure(err) ? 'rpc_unavailable' : 'read_failed'), balanceWei, minted };
    }

    const probe: AllowListMintRequest = { ownerId: params.ownerId, walletId: wallet.id, nftContract: params.nftContract, chainId: params.chainId, quantity: PROBE_QUANTITY, proofSource: 'opensea', slug: params.slug as string };
    const resolved = await this.mintExecutionService.resolveAllowListProof(probe, address, onChainRoot);
    if (!resolved.ok) {
      return {
        walletId: wallet.id,
        address,
        balanceWei,
        minted,
        limit: null,
        remaining: null,
        // OpenSea refusing to answer because the wallet cannot afford gas is "not yet known", not "not
        // on the list".
        eligible: resolved.reason === 'insufficient_funds' ? 'unknown' : 'not_eligible',
        reason: resolved.reason,
        priceWei: null,
      };
    }

    const { mintParams, proof } = resolved;
    const limit = mintParams.maxTotalMintableByWallet;
    const remaining = Math.max(0, limit - minted);
    const row: WalletEligibilityRow = {
      walletId: wallet.id,
      address,
      balanceWei,
      minted,
      limit,
      remaining,
      eligible: remaining > 0 ? 'eligible' : 'not_eligible',
      ...(remaining === 0 ? { reason: 'at_mint_limit' } : {}),
      priceWei: mintParams.mintPrice.toString(),
    };

    const nowSec = Math.floor(this.now() / 1000);
    const live = mintParams.startTime !== 0 && nowSec >= mintParams.startTime && nowSec <= mintParams.endTime;
    if (remaining === 0 || !live) return row;
    const feeRecipient = (await chain.seaDropReader.getAllowedFeeRecipients(scope))[0];
    if (!feeRecipient) return row;
    const tx = this.builder.buildMintAllowListTx(scope, feeRecipient, PROBE_QUANTITY, mintParams, proof);
    return { ...row, simulation: await this.simulate(chain, wallet, scope.chainId, tx) };
  }

  private async checkSignedOne(chain: ChainServices, scope: { nftContract: `0x${string}`; chainId: number }, params: CheckPhaseParams, wallet: { id: string; address: string }, source: OpenSeaEligibilitySource): Promise<WalletEligibilityRow> {
    const address = wallet.address as `0x${string}`;
    const balanceWei = await this.balanceOf(chain, address);

    let minted: number;
    try {
      minted = (await chain.seaDropReader.getMintStats(scope, address)).minterNumMinted;
    } catch (err) {
      return { ...this.unknownRow(wallet, isRpcTransportFailure(err) ? 'rpc_unavailable' : 'read_failed'), balanceWei };
    }

    const answer = await source.stagesFor({ id: wallet.id, address }, params.slug as string);
    if (!answer.ok) return { ...this.unknownRow(wallet, answer.reason), balanceWei, minted };
    const stages = answer.stages;

    // normalizeStageUuid's own doc comment has the real bug this works around.
    const stage = stages.find((s) => normalizeStageUuid(s.stage_uuid) === normalizeStageUuid(params.phase.openSeaStageUuid));
    if (!stage) return { ...this.unknownRow(wallet, 'stage_not_in_opensea_response'), balanceWei, minted };

    const limit = stage.max_total_mintable_by_wallet !== null ? Number(stage.max_total_mintable_by_wallet) : null;
    const remaining = limit === null ? null : Math.max(0, limit - minted);
    return {
      walletId: wallet.id,
      address,
      balanceWei,
      minted,
      limit,
      remaining,
      eligible: stage.is_eligible && remaining !== 0 ? 'eligible' : 'not_eligible',
      ...(!stage.is_eligible ? { reason: 'not_on_allowlist' } : remaining === 0 ? { reason: 'at_mint_limit' } : {}),
      priceWei: stage.price,
      // No simulation: a mintSigned transaction needs a signature that only exists once the phase is
      // live.
    };
  }
}
