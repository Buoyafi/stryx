import type { WalletService, UserId } from '@stryx/wallet-service';
import { SeaDropTransactionBuilder, decodeSeaDropRevertData, type MintParams } from '@stryx/nft-engine';
import {
  BroadcastUncertainError,
  EmergencyStopActiveError,
  SimulationRevertedError,
  SpendingCapExceededError,
  RpcUnavailableError,
  type TransactionResult,
} from '@stryx/transaction-engine';
import { isRpcTransportFailure, isInsufficientFundsFailure } from '@stryx/utils';
import { SeaDropAllowListTree, EligibilityChecker, type AllowListEntry } from '@stryx/eligibility';
import type { ChainServices } from './chain-services.js';
import { chainById } from './chain-registry.js';
import { seaDropMissingMessage } from './seadrop-support.js';
import type { AllowListStore } from './allowlist-store.js';
import { OpenSeaDropError, type OpenSeaProofFetcher } from './opensea-drop-client.js';
import type { SpendCapResolver } from './spend-cap-resolver.js';
import type { MintConfirmationWatcher } from './mint-confirmation-watcher.js';
import { safeNote, type MintEventKind, type MintEventRepository, type MintEventSource } from './mint-event-log.js';
import type { Logger } from '@stryx/logger';

/**
 * The single place that executes a SeaDrop mint, called by the HTTP controllers (mint now) and the
 * scheduler (mint later). Failures are returned as a typed outcome, never thrown.
 */

export type MintOutcome =
  | { ok: true; result: TransactionResult }
  | { ok: false; reason: MintFailureReason; detail?: string; stage?: string; hash?: `0x${string}`; nonce?: number };

/** Shown wherever a send's outcome could not be established. */
export const SEND_UNCONFIRMED_MESSAGE = 'May have been sent. Check Activity before retrying.';

export type MintFailureReason =
  | 'unsupported_chain'
  | 'no_active_public_stage'
  | 'no_fee_recipient_configured'
  | 'not_eligible'
  /**
   * OpenSea refused the proof fetch because the wallet cannot afford the mint: distinct from
   * 'not_eligible', and fixed by funding the wallet.
   */
  | 'insufficient_funds'
  | 'allowlist_not_found'
  | 'opensea_fetch_failed'
  | 'emergency_stop'
  | 'simulation_reverted'
  | 'spending_cap_exceeded'
  /**
   * The chain could not be reached, as opposed to 'simulation_reverted' (the chain answered and the
   * contract said no). Safe to retry.
   */
  | 'rpc_unavailable'
  /** The send call failed and the chain could not say whether the transaction went out. */
  | 'send_unconfirmed'
  /** The per-token price is above the ceiling the request carries (`maxPriceWei`). Nothing is sent. */
  | 'price_above_limit'
  /** The wallet is archived (or otherwise not ACTIVE). A job scheduled before that must not spend from it. */
  | 'wallet_not_active'
  /**
   * The mint log could not record the attempt, so nothing was signed (ADR-003 §4.9: an unrecorded mint
   * is exactly what the log exists to prevent).
   */
  | 'history_unavailable';

export interface PublicMintRequest {
  /**
   * ADR-002 §3.6: resolved from the caller's identity, never from request input, and checked again
   * when a scheduled mint fires.
   */
  ownerId: UserId;
  walletId: string;
  nftContract: `0x${string}`;
  chainId: number;
  quantity: number;
  /** The priority fee (tip) to pay, in wei (decimal string: this request travels through Redis for a scheduled mint). */
  priorityFeeWei?: string;
  /** The most this mint may pay per token, in wei (decimal string). */
  maxPriceWei?: string;
  /** Who asked, for the mint log: a dashboard session, the scheduler, or a bearer credential. */
  source?: MintEventSource;
  /** The scheduled job this mint belongs to, when there is one: groups a run in the mint log. */
  jobId?: string;
}

/** How a mint fired on a timer handles the moments around a stage's start. */
export interface StartPatience {
  /** Wait, inside the attempt, for a public stage that opens within this long. */
  waitForStartMs: number;
  /** A pre-send check that says NotActive is asked again this many times, this far apart. */
  notActiveRetries: number;
  notActiveRetryMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export type AllowListMintRequest = PublicMintRequest &
  (
    | { proofSource: 'direct'; mintParams: MintParams; proof: readonly `0x${string}`[] }
    | { proofSource: 'stored'; allowListId: string }
    | { proofSource: 'opensea'; slug: string }
  );

export class MintExecutionService {
  private readonly builder = new SeaDropTransactionBuilder();
  private readonly eligibilityChecker = new EligibilityChecker();

  constructor(
    private readonly walletService: WalletService,
    private readonly chainServices: Map<number, ChainServices>,
    private readonly allowListStore: AllowListStore,
    /** Structurally typed so a caching wrapper can stand in for the real client. */
    private readonly openSeaDropClient: OpenSeaProofFetcher,
    private readonly spendCapResolver: SpendCapResolver,
    /** Optional so tests that do not track NFTs need none. */
    private readonly mintConfirmationWatcher?: MintConfirmationWatcher,
    /** The mint log (ADR-003 §4.9). */
    private readonly mintLog?: { repository: MintEventRepository; logger: Logger },
  ) {}

  /** Runs one mint attempt with its log row. */
  private async logged(req: PublicMintRequest, kind: MintEventKind, run: (recording: Recording) => Promise<MintOutcome>): Promise<MintOutcome> {
    const recording = new Recording(this.mintLog, req, kind);
    let outcome: MintOutcome;
    try {
      outcome = await run(recording);
    } catch (err) {
      await recording.finish({ ok: false, reason: 'rpc_unavailable', detail: 'internal_error' }, true);
      throw err;
    }
    await recording.finish(outcome);
    return outcome;
  }

  async executePublicMint(req: PublicMintRequest, patience?: StartPatience): Promise<MintOutcome> {
    return this.logged(req, 'PUBLIC', (recording) => this.runPublicMint(req, recording, patience));
  }

  private async runPublicMint(req: PublicMintRequest, recording: Recording, patience?: StartPatience): Promise<MintOutcome> {
    const chain = this.chainServices.get(req.chainId);
    if (!chain) return { ok: false, reason: 'unsupported_chain', detail: String(req.chainId) };
    if ((await chain.seaDropSupport?.isDeployed()) === false) {
      return { ok: false, reason: 'unsupported_chain', detail: seaDropMissingMessage(chainById(req.chainId)?.name ?? `Chain ${req.chainId}`) };
    }

    const scope = { nftContract: req.nftContract, chainId: req.chainId };
    const wallet = await this.walletService.getWalletSummary(req.ownerId, req.walletId);
    recording.walletAddress = wallet.address;
    if (wallet.status !== 'ACTIVE') return walletNotActive(wallet.status);

    // These are live chain reads, grouped so an unreachable RPC comes back as 'rpc_unavailable'.
    let unsignedTx: { to: `0x${string}`; data: `0x${string}`; value: bigint };
    try {
      const publicDrop = await chain.seaDropReader.getPublicDrop(scope);
      // A job that fired just ahead of the start waits for it here rather than giving up on it.
      const waited = await waitForStart(publicDrop.startTime, patience);
      if (!waited && !(await chain.seaDropReader.isPublicStageActive(scope))) {
        return { ok: false, reason: 'no_active_public_stage' };
      }

      const overPrice = priceAboveLimit(req, publicDrop.mintPrice);
      if (overPrice) return overPrice;

      const feeRecipients = await chain.seaDropReader.getAllowedFeeRecipients(scope);
      const feeRecipient = feeRecipients[0];
      if (!feeRecipient) return { ok: false, reason: 'no_fee_recipient_configured' };

      unsignedTx = this.builder.buildMintPublicTx(scope, feeRecipient, req.quantity, publicDrop.mintPrice);
    } catch (err) {
      const outcome = this.classifyReadFailure(err);
      if (outcome) return outcome;
      throw err;
    }

    return this.executeThroughEngine(chain, req, wallet.address, unsignedTx, recording, patience);
  }

  async executeAllowListMint(req: AllowListMintRequest, patience?: StartPatience): Promise<MintOutcome> {
    return this.logged(req, 'ALLOWLIST', (recording) => this.runAllowListMint(req, recording, patience));
  }

  private async runAllowListMint(req: AllowListMintRequest, recording: Recording, patience?: StartPatience): Promise<MintOutcome> {
    const chain = this.chainServices.get(req.chainId);
    if (!chain) return { ok: false, reason: 'unsupported_chain', detail: String(req.chainId) };
    if ((await chain.seaDropSupport?.isDeployed()) === false) {
      return { ok: false, reason: 'unsupported_chain', detail: seaDropMissingMessage(chainById(req.chainId)?.name ?? `Chain ${req.chainId}`) };
    }

    const scope = { nftContract: req.nftContract, chainId: req.chainId };
    const wallet = await this.walletService.getWalletSummary(req.ownerId, req.walletId);
    recording.walletAddress = wallet.address;
    if (wallet.status !== 'ACTIVE') return walletNotActive(wallet.status);

    // Always read the live on-chain root: it stops a stale or wrong proof from wasting gas on a
    // revert.
    let onChainRoot: `0x${string}`;
    try {
      onChainRoot = await chain.seaDropReader.getAllowListMerkleRoot(scope);
    } catch (err) {
      const outcome = this.classifyReadFailure(err);
      if (outcome) return outcome;
      throw err;
    }

    const resolved = await this.resolveAllowListProof(req, wallet.address as `0x${string}`, onChainRoot);
    if (!resolved.ok) return { ok: false, reason: resolved.reason, ...(resolved.detail ? { detail: resolved.detail } : {}) };
    const { mintParams, proof } = resolved;
    const overPrice = priceAboveLimit(req, mintParams.mintPrice);
    if (overPrice) return overPrice;

    let unsignedTx: { to: `0x${string}`; data: `0x${string}`; value: bigint };
    try {
      const feeRecipients = await chain.seaDropReader.getAllowedFeeRecipients(scope);
      const feeRecipient = feeRecipients[0];
      if (!feeRecipient) return { ok: false, reason: 'no_fee_recipient_configured' };

      unsignedTx = this.builder.buildMintAllowListTx(scope, feeRecipient, req.quantity, mintParams, proof);
    } catch (err) {
      const outcome = this.classifyReadFailure(err);
      if (outcome) return outcome;
      throw err;
    }

    return this.executeThroughEngine(chain, req, wallet.address, unsignedTx, recording, patience);
  }

  /**
   * Resolves an allow-list mint's (mintParams, proof) pair, with the same verification a real mint
   * uses, without executing a mint.
   */
  async resolveAllowListProof(
    req: AllowListMintRequest,
    walletAddress: `0x${string}`,
    onChainRoot: `0x${string}`,
  ): Promise<
    | { ok: true; mintParams: MintParams; proof: readonly `0x${string}`[] }
    | { ok: false; reason: MintFailureReason; detail?: string }
  > {
    if (req.proofSource === 'direct') {
      const result = this.eligibilityChecker.verifyGivenProof(walletAddress, req.mintParams, req.proof, onChainRoot);
      if (!result.eligible) return { ok: false, reason: 'not_eligible', detail: result.reason };
      return { ok: true, mintParams: req.mintParams, proof: req.proof };
    }

    if (req.proofSource === 'opensea') {
      // Fetch OpenSea's proof + mintParams (decoded from their mint calldata, never signed).
      let fetched;
      try {
        fetched = await this.openSeaDropClient.fetchAllowListData(req.slug, walletAddress, req.quantity);
      } catch (err) {
        if (err instanceof OpenSeaDropError) {
          // Map OpenSea's own outcomes onto our reasons.
          if (err.code === 'not_eligible') return { ok: false, reason: 'not_eligible', detail: 'opensea:not_eligible' };
          if (err.code === 'insufficient_funds') return { ok: false, reason: 'insufficient_funds', detail: err.message };
          return { ok: false, reason: 'opensea_fetch_failed', detail: `${err.code}: ${err.message}` };
        }
        throw err;
      }

      const result = this.eligibilityChecker.verifyGivenProof(walletAddress, fetched.mintParams, fetched.proof, onChainRoot);
      if (!result.eligible) {
        // OpenSea's proof does not verify against the on-chain root: refuse to sign.
        return { ok: false, reason: 'not_eligible', detail: `opensea_proof_unverified:${result.reason}` };
      }
      return { ok: true, mintParams: fetched.mintParams, proof: fetched.proof };
    }

    const entries: readonly AllowListEntry[] | null = await this.allowListStore.get(req.allowListId);
    if (!entries) return { ok: false, reason: 'allowlist_not_found', detail: req.allowListId };

    const tree = SeaDropAllowListTree.build(entries);
    const result = this.eligibilityChecker.checkEligibility(tree, onChainRoot, walletAddress, undefined, Math.floor(Date.now() / 1000));
    if (!result.eligible) return { ok: false, reason: 'not_eligible', detail: result.reason };
    return { ok: true, mintParams: result.mintParams, proof: result.proof as `0x${string}`[] };
  }

  /** A transport failure on any chain read maps to 'rpc_unavailable'. */
  private classifyReadFailure(err: unknown): MintOutcome | undefined {
    if (isRpcTransportFailure(err)) {
      return { ok: false, reason: 'rpc_unavailable', detail: err instanceof Error ? err.message : String(err) };
    }
    return undefined;
  }

  private async executeThroughEngine(
    chain: ChainServices,
    req: PublicMintRequest,
    walletAddress: string,
    unsignedTx: { to: `0x${string}`; data: `0x${string}`; value: bigint },
    recording: Recording,
    patience?: StartPatience,
  ): Promise<MintOutcome> {
    // Write-ahead: the attempt is on record before anything is signed, or it does not happen.
    if (!(await recording.begin(unsignedTx.value))) {
      return { ok: false, reason: 'history_unavailable', detail: 'The mint could not be recorded, so it was not sent. Try again shortly.' };
    }
    try {
      const spendCapWei = await this.spendCapResolver.resolve(req.ownerId, req.chainId);
      const walletSpendCapWei = this.spendCapResolver.walletCap(spendCapWei);
      // The engine's pre-send checks run against the latest block.
      let result: TransactionResult;
      for (let notActive = 0; ; notActive++) {
        try {
          result = await chain.transactionEngine.executeTransaction(
            { chainId: req.chainId, walletId: req.walletId, walletAddress, ownerId: req.ownerId, spendCapWei, walletSpendCapWei },
            unsignedTx,
            { ...(req.priorityFeeWei ? { priorityFeeWei: BigInt(req.priorityFeeWei) } : {}), onSigned: (signed) => recording.signed(signed) },
          );
          break;
        } catch (err) {
          if (!patience || notActive >= patience.notActiveRetries || !isNotActiveRevert(err)) throw err;
          await (patience.sleep ?? sleep)(patience.notActiveRetryMs);
        }
      }
      this.watchConfirmation(req, walletAddress, result.hash, result.nonce);
      return { ok: true, result };
    } catch (err) {
      if (err instanceof BroadcastUncertainError) {
        // It may be on its way: watch for it like any sent mint, and say so instead of "failed".
        this.watchConfirmation(req, walletAddress, err.hash, err.nonce);
        return { ok: false, reason: 'send_unconfirmed', detail: SEND_UNCONFIRMED_MESSAGE, hash: err.hash, nonce: err.nonce };
      }
      if (err instanceof EmergencyStopActiveError) {
        return { ok: false, reason: 'emergency_stop', stage: err.stage };
      }
      if (err instanceof SpendingCapExceededError) {
        return { ok: false, reason: 'spending_cap_exceeded', detail: err.message };
      }
      if (err instanceof RpcUnavailableError) {
        return { ok: false, reason: 'rpc_unavailable', detail: err.message, stage: err.stage };
      }
      if (err instanceof SimulationRevertedError) {
        if (isInsufficientFundsFailure(err)) return { ok: false, reason: 'insufficient_funds', detail: NOT_ENOUGH_FOR_PRICE };
        const decoded = err.revertData ? decodeSeaDropRevertData(err.revertData) : undefined;
        return { ok: false, reason: 'simulation_reverted', detail: decoded ?? err.message };
      }
      // A wallet can pass simulation and still be refused at the real send for lack of funds: report
      // that as a short reason, not viem's raw error.
      if (isInsufficientFundsFailure(err)) {
        return { ok: false, reason: 'insufficient_funds', detail: 'Insufficient funds for gas.' };
      }
      throw err; // genuinely unexpected: let it propagate to the caller's error handler
    }
  }

  /** Fire-and-forget: never awaited, never delays the response. */
  private watchConfirmation(req: PublicMintRequest, walletAddress: string, hash: `0x${string}`, nonce: number): void {
    void this.mintConfirmationWatcher
      ?.enqueue({
        hash,
        nonce,
        walletId: req.walletId,
        walletAddress: walletAddress as `0x${string}`,
        chainId: req.chainId,
        contract: req.nftContract,
        ownerId: req.ownerId,
        standard: 'erc721',
      })
      .catch(() => undefined);
  }
}


/** The pre-send check runs with no gas price, so only the mint price can be what the wallet could not cover. */
export const NOT_ENOUGH_FOR_PRICE = 'Not enough funds for the mint price.';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sleeps until a start that is close enough to wait for. True if it waited: the stage is at its start now. */
async function waitForStart(startTimeUnix: number, patience: StartPatience | undefined): Promise<boolean> {
  if (!patience || startTimeUnix === 0) return false;
  const opensInMs = startTimeUnix * 1000 - Date.now();
  if (opensInMs <= 0 || opensInMs > patience.waitForStartMs) return false;
  await (patience.sleep ?? sleep)(opensInMs);
  return true;
}

function isNotActiveRevert(err: unknown): boolean {
  if (!(err instanceof SimulationRevertedError) || !err.revertData) return false;
  return decodeSeaDropRevertData(err.revertData)?.startsWith('NotActive') ?? false;
}

function walletNotActive(status: string): MintOutcome {
  return { ok: false, reason: 'wallet_not_active', detail: `Wallet is ${status.toLowerCase()}.` };
}

function priceAboveLimit(req: PublicMintRequest, mintPriceWei: bigint): MintOutcome | undefined {
  if (req.maxPriceWei === undefined || mintPriceWei <= BigInt(req.maxPriceWei)) return undefined;
  return { ok: false, reason: 'price_above_limit', detail: `Price is now ${mintPriceWei} wei per token, above the ${req.maxPriceWei} wei limit.` };
}

/** One attempt's row in the mint log. */
class Recording {
  walletAddress: string | null = null;
  private eventId: string | null = null;
  private hash: string | null = null;
  private nonce: number | null = null;
  /** The row has its hash and is PENDING. False after signing means that write failed. */
  private hashSaved = false;

  constructor(
    private readonly log: { repository: MintEventRepository; logger: Logger } | undefined,
    private readonly req: PublicMintRequest,
    private readonly kind: MintEventKind,
  ) {}

  private base() {
    return {
      ownerId: this.req.ownerId as string,
      walletId: this.req.walletId,
      walletAddress: this.walletAddress ?? '',
      chainId: this.req.chainId,
      contractAddress: this.req.nftContract,
      kind: this.kind,
      quantity: this.req.quantity,
      source: this.req.source ?? 'API',
      jobId: this.req.jobId ?? null,
    };
  }

  /** Inserts the SENDING row. False means it could not be recorded, so the mint must not go ahead. */
  async begin(valueWei: bigint): Promise<boolean> {
    if (!this.log) return true;
    try {
      this.eventId = await this.log.repository.insert({ ...this.base(), valueWei: valueWei.toString(), status: 'SENDING' });
      return true;
    } catch (err) {
      this.log.logger.error('mint log: could not record the attempt; not sending', { walletId: this.req.walletId, chainId: this.req.chainId, err: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Called by the engine between signing and sending: the hash is on record before the send. */
  async signed(signed: { hash: string; nonce: number }): Promise<void> {
    this.hash = signed.hash;
    this.nonce = signed.nonce;
    if (!this.log || !this.eventId) return;
    await this.log.repository.update(this.eventId, { status: 'PENDING', txHash: signed.hash, nonce: signed.nonce });
    this.hashSaved = true;
  }

  async finish(outcome: MintOutcome, crashed = false): Promise<void> {
    if (!this.log) return;
    const { repository, logger } = this.log;
    try {
      if (this.eventId) {
        if (outcome.ok) {
          // The hook normally moved it to PENDING already; if that write failed, do it now.
          await repository.update(this.eventId, {
            ...(this.hashSaved ? {} : { status: 'PENDING', txHash: outcome.result.hash, nonce: outcome.result.nonce }),
            broadcastAt: new Date(),
          });
        } else if (!this.hash) {
          // Nothing was signed: refused before sending.
          await repository.update(this.eventId, { status: 'BLOCKED', failureReason: crashed ? 'internal_error' : outcome.reason, failureNote: safeNote(crashed ? null : outcome.detail) });
        } else if (!this.hashSaved) {
          // Signed, the hash was never saved, and the send failed or is unknown: save it now.
          await repository.update(this.eventId, { status: 'PENDING', txHash: this.hash, ...(this.nonce !== null ? { nonce: this.nonce } : {}) });
        }
        // Signed but the send failed: stays PENDING with its hash; the reconciler decides from the chain.
      } else if (!outcome.ok && this.walletAddress && outcome.reason !== 'history_unavailable') {
        // Refused before it reached the engine (not eligible, stage closed...): on record as BLOCKED.
        await repository.insert({ ...this.base(), valueWei: null, status: 'BLOCKED', failureReason: crashed ? 'internal_error' : outcome.reason, failureNote: safeNote(crashed ? null : outcome.detail) });
      }
    } catch (err) {
      logger.error('mint log: could not record the outcome', { walletId: this.req.walletId, chainId: this.req.chainId, err: err instanceof Error ? err.message : String(err) });
    }
  }
}
