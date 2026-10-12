import type { UserId, WalletService } from '@stryx/wallet-service';
import type { Logger } from '@stryx/logger';
import { withTimeout, isInsufficientFundsFailure } from '@stryx/utils';
import { NOT_ENOUGH_FOR_PRICE } from './mint-execution.service.js';
import { SEADROP_ADDRESS, decodeSeaDropRevertData, type SignedMintValidationParams } from '@stryx/nft-engine';
import {
  BroadcastUncertainError,
  EmergencyStopActiveError,
  RpcUnavailableError,
  SimulationRevertedError,
  SpendingCapExceededError,
  type PreparedExecutionStep,
} from '@stryx/transaction-engine';
import type { ChainServices } from './chain-services.js';
import { ineligibleForAnotherStage, type MintCalldataAnswer, type OpenSeaSignedMintClient } from './opensea-signed-mint-client.js';
import { OpenSeaRequestLimiter, PausedPastDeadlineError } from './opensea-request-limiter.js';
import { validateSignedMintCalldata } from './signed-mint-validator.js';
import { readSignerBounds } from './signed-mint-start-resolver.js';
import { evaluateClock, readingFromBlock, readingFromHttpDate, type ClockReading } from './clock-check.js';
import { gasLimitFor, gasPresetFor, presetFees } from './gas-presets.js';
import { minPriorityFeeWei } from './chain-services.js';
import { seaDropMissingMessage } from './seadrop-support.js';
import { chainById } from './chain-registry.js';
import type { AttemptPatch, AttemptStatus, RunPatch, SignedMintRepository } from './signed-mint-repository.js';
import type { SpendCapResolver } from './spend-cap-resolver.js';
import type { MintConfirmationWatcher } from './mint-confirmation-watcher.js';
import type { AuditLogService } from './audit-log-service.js';
import { chainErrorText } from './chain-error-text.js';

/** What one scheduled signed-mint job carries through Redis. Bigints travel as decimal strings. */
export interface SignedMintJobData {
  ownerId: UserId;
  chainId: number;
  nftContract: `0x${string}`;
  slug: string;
  stageUuid: string;
  stageLabel: string;
  /** T-0: the stage start, unix ms. The 30s re-check keeps this current. */
  startMs: number;
  /** The per-token price the operator accepted when scheduling. A signed price above it is refused. */
  maxPriceWei: string;
  wallets: Array<{ walletId: string; quantity: number }>;
  settings: {
    simulate: boolean;
    dryRun: boolean;
    /** Optional ceiling on the total mint value this job may send, across every wallet. */
    maxSpendWei: string | null;
    /** The priority fee (tip) in wei for every send; unset means the warm-up estimate's. */
    priorityFeeWei?: string;
    retryIntervalMs: number;
    giveUpMs: number;
  };
  /** A dry-run rehearsal at a time the operator chose: T-0 is `startMs`, never re-read from OpenSea. */
  rehearsal: boolean;
  /**
   * "Mint now" on a stage that is already live: T-0 is the moment it was pressed plus the warm-up
   * lead, never re-read from OpenSea.
   */
  immediate?: boolean;
}

export type SignedMintRunResult =
  | { status: 'finished'; counts: Record<string, number> }
  | { status: 'disabled' | 'aborted' }
  | { status: 'moved'; startMs: number };

/** Redis-backed flags the runner consults: a per-wallet "already sent" marker and a job abort flag. */
export interface SignedMintFlags {
  /** True only the FIRST time for a (job, wallet): a re-run of the same job can never send twice. */
  claimSend(jobId: string, walletId: string): Promise<boolean>;
  isAborted(jobId: string): Promise<boolean>;
  abort(jobId: string): Promise<void>;
}

/** Structural, like StepUpRedisClient: exactly the two `set` shapes used here, which ioredis provides. */
export interface SignedMintFlagsRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', seconds: number, nx: 'NX'): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export class RedisSignedMintFlags implements SignedMintFlags {
  constructor(private readonly redis: SignedMintFlagsRedis) {}

  async claimSend(jobId: string, walletId: string): Promise<boolean> {
    const res = await this.redis.set(`signed-mint:sent:${jobId}:${walletId}`, '1', 'EX', 7 * 86_400, 'NX');
    return res === 'OK';
  }

  async isAborted(jobId: string): Promise<boolean> {
    return (await this.redis.get(`signed-mint:abort:${jobId}`)) === '1';
  }

  async abort(jobId: string): Promise<void> {
    await this.redis.set(`signed-mint:abort:${jobId}`, '1', 'EX', 86_400);
  }
}

export interface RunnerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: RunnerClock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))) };

export interface RunnerTiming {
  /** The job fires this long before T-0. */
  warmupLeadMs: number;
  /** Calldata requests start this long before T-0. */
  fetchLeadMs: number;
  /** Connection keep-alive ping interval between warm-up and the first calldata request. */
  keepAliveIntervalMs: number;
  receiptTimeoutMs: number;
  receiptPollMs: number;
  /** One OpenSea mint request is abandoned (and retried) after this long: a hung request must not stall its wallet. */
  openSeaRequestTimeoutMs: number;
  /** Budget for each warm-up chain read, so a slow RPC can never push warm-up past T-0. */
  warmupReadTimeoutMs: number;
  /** A NotActive simulation is retried this many times, this far apart, before the wallet fails (about 2s in all). */
  notActiveSimRetries: number;
  notActiveSimRetryMs: number;
  /** Overlapping calldata requests begin this long before T-0 (one at a time until then). */
  overlapLeadMs: number;
  /** ...and end this long after T-0: a stage that opens late is not hammered for the whole wait. */
  overlapWindowMs: number;
  /** The most the schedule is moved earlier for a clock that reads behind. */
  maxClockShiftMs: number;
}

export const DEFAULT_RUNNER_TIMING: RunnerTiming = {
  warmupLeadMs: 5_000,
  fetchLeadMs: 1_500,
  keepAliveIntervalMs: 2_000,
  receiptTimeoutMs: 300_000,
  receiptPollMs: 250,
  openSeaRequestTimeoutMs: 5_000,
  warmupReadTimeoutMs: 3_000,
  notActiveSimRetries: 8,
  notActiveSimRetryMs: 250,
  overlapLeadMs: 500,
  overlapWindowMs: 5_000,
  maxClockShiftMs: 3_000,
};

export interface SignedMintRunnerDeps {
  walletService: Pick<WalletService, 'getWalletSummary'>;
  chainServices: Map<number, ChainServices>;
  openSea: OpenSeaSignedMintClient;
  repository: SignedMintRepository;
  flags: SignedMintFlags;
  spendCapResolver: Pick<SpendCapResolver, 'resolve' | 'walletCap'>;
  confirmationWatcher?: Pick<MintConfirmationWatcher, 'enqueue'>;
  auditLogService?: Pick<AuditLogService, 'record'>;
  /** SIGNED_MINT_EXECUTION_ENABLED: the kill switch. */
  executionEnabled: boolean;
  openSeaConcurrency: number;
  /** SIGNED_MINT_OVERLAP_MS / SIGNED_MINT_MAX_IN_FLIGHT. */
  overlap?: { intervalMs: number; maxInFlight: number };
  /** SIGNED_MINT_HOLD_KEYS: unwrap each wallet's data key at warm-up and hold it until the wallet is done. */
  holdKeys?: boolean;
  logger: Logger;
  clock?: RunnerClock;
  timing?: Partial<RunnerTiming>;
}

/** A clock reading within this of zero cannot be told from a correct clock (see clock-check.ts). */
const CLOCK_ROUNDING_MS = 500;

type CalldataCounters = { notActiveCount: number; rateLimitedCount: number; errorCount: number; requestCount: number };

interface WalletRun {
  walletId: string;
  address: `0x${string}`;
  quantity: number;
  gasLimit: bigint;
}

interface JobContext {
  jobId: string;
  data: SignedMintJobData;
  chain: ChainServices;
  t0: number;
  signerBounds: Map<string, SignedMintValidationParams>;
  feeRecipients: Set<string>;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  spendCapWei: bigint | null;
  /** Each wallet's own share of that cap (per-wallet caps). */
  walletSpendCapWei: bigint | null;
  limiter: OpenSeaRequestLimiter;
  /** Mint value committed so far across the job, for the optional per-job spend limit. */
  committedWei: bigint;
  /** Wallets that passed warm-up: how many connections to keep warm. */
  walletCount: number;
  /** When the first calldata request goes out: T-0 less the lead, less any clock shift. */
  fetchFrom: number;
  /** Requests overlap between these two moments (equal: never). */
  overlapFrom: number;
  overlapUntil: number;
  /** Set by the first 429: every wallet goes back to one request at a time for the rest of the job. */
  overlapOff: boolean;
}

/**
 * Runs one scheduled signed-mint job. About 5s before the stage starts it warms up: kill switch, clock
 * check, on-chain signers, fee preset, then each wallet's ownership, nonce and balance. Just before
 * the start every wallet asks OpenSea for its mint calldata in parallel, retrying "not active" until
 * it arrives or the give-up time passes. Each wallet then validates, simulates, signs and sends. Every
 * step is written to the signed-mint log as ms from the start, and each wallet ends in exactly one
 * recorded state.
 */
export class SignedMintRunner {
  private readonly clock: RunnerClock;
  private readonly timing: RunnerTiming;

  constructor(private readonly deps: SignedMintRunnerDeps) {
    this.clock = deps.clock ?? realClock;
    this.timing = { ...DEFAULT_RUNNER_TIMING, ...deps.timing };
  }

  /** Bookkeeping for the run and for a wallet's attempt. */
  private async note(jobId: string, patch: RunPatch): Promise<void> {
    await this.deps.repository.updateRun(jobId, patch).catch((err: unknown) => {
      this.deps.logger.error('signed mint: failed to record run status', { jobId, message: message(err) });
    });
  }

  private async mark(identity: Parameters<SignedMintRepository['upsertAttempt']>[0], patch: AttemptPatch): Promise<void> {
    await this.deps.repository.upsertAttempt(identity, patch).catch((err: unknown) => {
      this.deps.logger.error('signed mint: failed to record attempt', { jobId: identity.jobId, walletId: identity.walletId, message: message(err) });
    });
  }

  async run(jobId: string, data: SignedMintJobData): Promise<SignedMintRunResult> {
    const { repository, logger } = this.deps;
    // The scheduler wrote this row when the job was queued; this refreshes it and must not stop the run.
    await repository
      .upsertRun({
        jobId,
        ownerId: data.ownerId,
        chainId: data.chainId,
        contract: data.nftContract,
        slug: data.slug,
        stageUuid: data.stageUuid,
        stageLabel: data.stageLabel,
        t0: new Date(data.startMs),
        dryRun: data.settings.dryRun,
        simulate: data.settings.simulate,
        rehearsal: data.rehearsal,
        status: 'warming_up',
      })
      .catch((err: unknown) => logger.error('signed mint: failed to record run start', { jobId, message: message(err) }));

    if (!this.deps.executionEnabled) {
      await this.failAll(jobId, data, 'execution_disabled', 'SIGNED_MINT_EXECUTION_ENABLED is off: nothing was attempted.');
      await this.note(jobId, { status: 'disabled', finishedAt: new Date(this.clock.now()) });
      logger.warn('signed mint job not run: execution disabled', { jobId });
      return { status: 'disabled' };
    }

    const chain = this.deps.chainServices.get(data.chainId);
    if (!chain) {
      await this.failAll(jobId, data, 'unsupported_chain', `No RPC configured for chain ${data.chainId}.`);
      await this.note(jobId, { status: 'finished', finishedAt: new Date(this.clock.now()), notes: 'unsupported chain' });
      return { status: 'finished', counts: { failed: data.wallets.length } };
    }
    if ((await chain.seaDropSupport?.isDeployed()) === false) {
      await this.failAll(jobId, data, 'unsupported_chain', seaDropMissingMessage(chainById(data.chainId)?.name ?? `Chain ${data.chainId}`));
      await this.note(jobId, { status: 'finished', finishedAt: new Date(this.clock.now()), notes: 'SeaDrop not deployed on this chain' });
      return { status: 'finished', counts: { failed: data.wallets.length } };
    }

    const warm = await this.warmUp(jobId, data, chain);
    if (warm.kind === 'moved') return { status: 'moved', startMs: warm.startMs };
    if (warm.kind === 'failed') {
      await this.note(jobId, { status: 'finished', finishedAt: new Date(this.clock.now()), notes: warm.note });
      return { status: 'finished', counts: { failed: data.wallets.length } };
    }
    const { ctx, wallets } = warm;

    // A held key is zeroed the moment its wallet ends, and again for all of them on the way out.
    const releaseKey = (w: WalletRun) => {
      if (this.deps.holdKeys && !data.settings.dryRun) chain.transactionEngine.releaseSigning(w.walletId);
    };
    let results: string[];
    try {
      // If the flag cannot be read here, each wallet checks it again before asking and before sending.
      if (await this.deps.flags.isAborted(jobId).catch(() => false)) return await this.abortRun(jobId, data, wallets);

      await this.keepAliveUntil(ctx, ctx.fetchFrom);
      await this.note(jobId, { status: 'fetching' });

      // One wallet's unexpected error ends that wallet, never the run: the others are already in flight.
      results = await Promise.all(
        wallets.map((w) =>
          this.fireWallet(ctx, w)
            .catch(async (err: unknown) => {
              logger.error('signed mint: wallet ended on an unexpected error', { jobId, walletId: w.walletId, message: message(err) });
              await this.mark({ jobId, ownerId: data.ownerId, walletId: w.walletId, walletAddress: w.address, quantity: w.quantity }, { status: 'failed', reason: 'internal_error', detail: message(err) });
              return 'failed';
            })
            .finally(() => releaseKey(w)),
        ),
      );
    } finally {
      for (const w of wallets) releaseKey(w);
    }
    const counts = results.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
    await this.note(jobId, { status: 'finished', finishedAt: new Date(this.clock.now()) });
    logger.info('signed mint job finished', { jobId, counts });
    return { status: 'finished', counts };
  }

  private async warmUp(
    jobId: string,
    data: SignedMintJobData,
    chain: ChainServices,
  ): Promise<{ kind: 'ready'; ctx: JobContext; wallets: WalletRun[] } | { kind: 'moved'; startMs: number } | { kind: 'failed'; note: string }> {
    const { logger } = this.deps;
    const notes: string[] = [];
    const scope = { nftContract: data.nftContract, chainId: data.chainId };

    // Chain identity, clock and the latest OpenSea start, together.
    const readings: ClockReading[] = [];
    let t0 = data.startMs;
    try {
      const sent = this.clock.now();
      const [chainId, block] = await this.bounded(Promise.all([chain.publicClient.getChainId(), chain.publicClient.getBlock({ blockTag: 'latest' })]), 'chain id and latest block');
      const received = this.clock.now();
      if (chainId !== data.chainId) {
        await this.failAll(jobId, data, 'wrong_chain', `The RPC reports chain ${chainId}, not ${data.chainId}.`);
        return { kind: 'failed', note: `RPC chain id ${chainId} != ${data.chainId}` };
      }
      readings.push(readingFromBlock(Number(block.timestamp), Math.round((sent + received) / 2), received - sent));
    } catch (err) {
      notes.push(`chain check failed: ${message(err)}`);
    }

    try {
      const snapshot = await this.bounded(this.deps.openSea.getDropStages(data.slug), 'OpenSea drop read');
      if (snapshot.serverDateMs !== null) readings.push(readingFromHttpDate(snapshot.serverDateMs, snapshot.localMidpointMs, snapshot.roundTripMs));
      if (!data.rehearsal && !data.immediate) {
        const stage = snapshot.stages.find((s) => s.uuid && sameUuid(s.uuid, data.stageUuid));
        const latest = stage?.startTime ? Date.parse(stage.startTime) : NaN;
        if (!Number.isNaN(latest) && latest !== data.startMs) {
          if (latest - this.clock.now() > this.timing.warmupLeadMs * 2) {
            notes.push(`OpenSea moved the start from ${new Date(data.startMs).toISOString()} to ${new Date(latest).toISOString()}`);
            await this.note(jobId, { status: 'moved', notes: notes.join('\n'), t0: new Date(latest) });
            logger.info('signed mint start moved at warm-up; rescheduling', { jobId, from: data.startMs, to: latest });
            return { kind: 'moved', startMs: latest };
          }
          notes.push(`start moved at warm-up to ${new Date(latest).toISOString()}; using it as T-0`);
          t0 = latest;
        }
      }
    } catch (err) {
      notes.push(`OpenSea drop read failed at warm-up: ${message(err)}`);
    }

    const clock = evaluateClock(readings);
    if (clock.skewed) {
      logger.error('SERVER CLOCK IS OFF BY MORE THAN 1 SECOND: signed mint timing will be wrong', { jobId, clock: clock.summary });
      notes.push(`WARNING: clock skew over 1s. ${clock.summary}`);
    }
    // A clock that reads behind would start asking late, and late is what loses a mint.
    const behindMs = Math.max(0, ...readings.map((r) => -r.offsetMs));
    const clockShiftMs = behindMs > CLOCK_ROUNDING_MS ? Math.min(this.timing.maxClockShiftMs, behindMs) : 0;
    if (clockShiftMs > 0) notes.push(`clock reads about ${clockShiftMs}ms behind: asking that much earlier`);

    // On-chain facts the validator needs, and the fee preset. Without these nothing can be validated.
    let signerBounds: Map<string, SignedMintValidationParams>;
    let feeRecipients: Set<string>;
    let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    try {
      // Essential: without these nothing can be validated or priced. One retry, each attempt bounded.
      const read = () =>
        this.bounded(
          Promise.all([readSignerBounds(chain.seaDropReader, scope), chain.seaDropReader.getAllowedFeeRecipients(scope), chain.publicClient.estimateFeesPerGas()]),
          'signers, fee recipients and fees',
        );
      const [bounds, recipients, estimate] = await read().catch(() => read());
      signerBounds = bounds;
      feeRecipients = new Set(recipients.map((r) => r.toLowerCase()));
      fees = presetFees(gasPresetFor(data.chainId), estimate, {
        priorityFeeWei: data.settings.priorityFeeWei ? BigInt(data.settings.priorityFeeWei) : undefined,
        minPriorityFeeWei: minPriorityFeeWei(data.chainId),
      });
    } catch (err) {
      await this.failAll(jobId, data, 'rpc_unavailable', `Warm-up could not read the contract or fees: ${message(err)}`);
      await this.note(jobId, { clockSkewed: clock.skewed, clockSummary: clock.summary, warmupAt: new Date(this.clock.now()) });
      return { kind: 'failed', note: 'warm-up chain reads failed' };
    }
    notes.push(`fees: maxFeePerGas ${fees.maxFeePerGas} wei, priority ${fees.maxPriorityFeePerGas} wei; ${signerBounds.size} signer(s)`);

    const spendCapWei = await this.deps.spendCapResolver.resolve(data.ownerId, data.chainId);
    const walletSpendCapWei = this.deps.spendCapResolver.walletCap(spendCapWei);
    const maxPrice = BigInt(data.maxPriceWei);
    const preset = gasPresetFor(data.chainId);

    const prepared = await Promise.all(
      data.wallets.map(async (plan): Promise<WalletRun | null> => {
        const identityBase = { jobId, ownerId: data.ownerId, walletId: plan.walletId, quantity: plan.quantity };
        let address: `0x${string}`;
        try {
          const wallet = await this.deps.walletService.getWalletSummary(data.ownerId, plan.walletId);
          address = wallet.address as `0x${string}`;
          if (wallet.status !== 'ACTIVE') {
            await this.mark({ ...identityBase, walletAddress: address }, { status: 'skipped', reason: 'wallet_not_active', detail: `Wallet is ${wallet.status}.` });
            return null;
          }
        } catch {
          await this.mark({ ...identityBase, walletAddress: '' }, { status: 'skipped', reason: 'wallet_not_found', detail: 'Wallet not found for this owner.' });
          return null;
        }
        const identity = { ...identityBase, walletAddress: address };
        await this.mark(identity, { status: 'pending' });

        const gasLimit = gasLimitFor(preset, plan.quantity);
        try {
          const [balance] = await this.bounded(
            Promise.all([chain.publicClient.getBalance({ address }), chain.transactionEngine.warmNonce({ chainId: data.chainId, walletAddress: address })]),
            'balance and nonce warm-up',
          );
          const needed = maxPrice * BigInt(plan.quantity) + gasLimit * fees.maxFeePerGas;
          if (balance < needed && !data.settings.dryRun) {
            await this.mark(identity, {
              status: 'skipped',
              reason: 'insufficient_funds',
              detail: `Balance ${balance} wei is below the ${needed} wei this mint could need (price x quantity + gas limit x max fee).`,
            });
            return null;
          }
          if (balance < needed) notes.push(`${address}: balance below what a real mint would need (dry run continues)`);
        } catch (err) {
          await this.mark(identity, { status: 'skipped', reason: 'warmup_failed', detail: `Warm-up failed: ${message(err)}` });
          return null;
        }
        return { walletId: plan.walletId, address, quantity: plan.quantity, gasLimit };
      }),
    );
    const wallets = prepared.filter((w): w is WalletRun => w !== null);

    // Signing path, in the background: fetch each wallet's encrypted key record and open the KMS
    // connection with a throwaway unwrap. The private key is not decrypted.
    if (!data.settings.dryRun) {
      const warmStarted = this.clock.now();
      for (const w of wallets) {
        // Held (if on) until the job would give up, plus a margin; released sooner when the wallet ends.
        const hold = this.deps.holdKeys ? { holdKeyMs: Math.max(1_000, t0 + data.settings.giveUpMs + 10_000 - this.clock.now()) } : {};
        void chain.transactionEngine
          .warmSigning(w.walletId, hold)
          .then(() => logger.info('signed mint: signing warmed', { jobId, walletId: w.walletId, ms: this.clock.now() - warmStarted, keyHeld: this.deps.holdKeys === true }))
          .catch((err: unknown) => logger.warn('signed mint: signing warm-up failed; it is tried again when sending', { jobId, walletId: w.walletId, message: message(err) }));
      }
    }

    // One warm connection per request that will run in parallel.
    this.warmConnections(chain, data.slug, wallets.length);

    // Overlap only where there is an opening to catch: a rehearsal has none, and "mint now" is already
    // open.
    const overlapOn = this.overlapConfigured() && !data.rehearsal && !data.immediate;
    const fetchFrom = t0 - this.timing.fetchLeadMs - clockShiftMs;
    const overlapFrom = t0 - this.timing.overlapLeadMs - clockShiftMs;
    const overlapUntil = overlapOn ? t0 + this.timing.overlapWindowMs : overlapFrom;
    notes.push(
      overlapOn
        ? `overlapping requests: every ${this.deps.overlap!.intervalMs}ms, up to ${this.deps.overlap!.maxInFlight} per wallet, ${this.deps.openSeaConcurrency} across the job`
        : 'overlapping requests: off',
    );
    if (!data.settings.dryRun) notes.push(`keys held from warm-up: ${this.deps.holdKeys ? 'yes' : 'no'}`);

    await this.note(jobId, {
      t0: new Date(t0),
      clockSkewed: clock.skewed,
      clockSummary: clock.summary,
      warmupAt: new Date(this.clock.now()),
      notes: notes.join('\n'),
    });
    logger.info('signed mint warm-up done', { jobId, ready: wallets.length, skipped: data.wallets.length - wallets.length, clock: clock.summary });

    return {
      kind: 'ready',
      wallets,
      ctx: {
        jobId,
        data,
        chain,
        t0,
        signerBounds,
        feeRecipients,
        fees,
        spendCapWei,
        walletSpendCapWei,
        limiter: new OpenSeaRequestLimiter({ maxConcurrent: this.deps.openSeaConcurrency, now: this.clock.now, sleep: this.clock.sleep }),
        committedWei: 0n,
        walletCount: wallets.length,
        fetchFrom,
        overlapFrom,
        overlapUntil,
        overlapOff: false,
      },
    };
  }

  private bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    return withTimeout(promise, this.timing.warmupReadTimeoutMs, label);
  }

  /** Keeps the RPC and OpenSea connections warm until `until`, then returns. Failures are ignored. */
  private async keepAliveUntil(ctx: JobContext, until: number): Promise<void> {
    const parallel = Math.max(1, ctx.walletCount);
    while (this.clock.now() < until) {
      const remaining = until - this.clock.now();
      if (remaining > this.timing.keepAliveIntervalMs) this.warmConnections(ctx.chain, ctx.data.slug, parallel);
      await this.clock.sleep(Math.min(remaining, this.timing.keepAliveIntervalMs));
    }
  }

  /**
   * Opens as many connections as will be used at once: Node's fetch opens one per request in flight
   * and closes an idle one after about 4s.
   */
  private warmConnections(chain: ChainServices, slug: string, walletCount: number): void {
    const perWallet = this.overlapConfigured() ? this.deps.overlap!.maxInFlight : 1;
    const openSeaParallel = Math.max(1, Math.min(walletCount * perWallet, this.deps.openSeaConcurrency));
    const rpcParallel = Math.max(1, Math.min(walletCount, 10));
    for (let i = 0; i < openSeaParallel; i++) void this.deps.openSea.getDropStages(slug).catch(() => undefined);
    for (let i = 0; i < rpcParallel; i++) void chain.publicClient.getBlockNumber().catch(() => undefined);
    // When sends go to two endpoints at once, the second one needs an open connection too.
    chain.warmBroadcast?.();
  }

  private overlapConfigured(): boolean {
    const o = this.deps.overlap;
    return o !== undefined && o.intervalMs > 0 && o.maxInFlight > 1;
  }

  /** One wallet, from its first calldata request to its final state. Returns that state. */
  private async fireWallet(ctx: JobContext, w: WalletRun): Promise<string> {
    const { data, jobId } = ctx;
    const identity = { jobId, ownerId: data.ownerId, walletId: w.walletId, walletAddress: w.address, quantity: w.quantity };
    const record = (patch: AttemptPatch) => this.deps.repository.upsertAttempt(identity, patch).catch((err: unknown) => {
      this.deps.logger.error('signed mint: failed to record attempt', { jobId, walletId: w.walletId, message: message(err) });
    });
    const since = () => this.clock.now() - ctx.t0;
    const finish = async (status: AttemptStatus, patch: AttemptPatch = {}): Promise<string> => {
      await record({ ...patch, status });
      return status;
    };

    // 1. Calldata, asked for until OpenSea stops saying "not active".
    const deadline = ctx.t0 + data.settings.giveUpMs;
    const fetched = await this.fetchCalldata(ctx, w, deadline);
    if (fetched.kind === 'ended') return finish(fetched.status, fetched.patch);
    const { calldata, openSeaTarget } = fetched;
    await record({ calldataMs: since(), ...fetched.counters });

    // 2. Validate against the on-chain facts read at warm-up. Only the canonical SeaDrop contract is
    // ever sent to.
    if (openSeaTarget !== null && openSeaTarget.toLowerCase() !== SEADROP_ADDRESS.toLowerCase()) {
      return finish('failed', { reason: 'unexpected_target', detail: `OpenSea's transaction targets ${openSeaTarget}, not the SeaDrop contract.` });
    }
    const validation = await validateSignedMintCalldata(calldata, {
      chainId: data.chainId,
      nftContract: data.nftContract,
      walletAddress: w.address,
      quantity: w.quantity,
      maxPriceWei: BigInt(data.maxPriceWei),
      signerBounds: ctx.signerBounds,
      allowedFeeRecipients: ctx.feeRecipients,
    });
    if (!validation.ok) return finish('failed', { reason: validation.reason, detail: validation.detail });
    const tx = validation.tx;
    if (validation.note) {
      this.deps.logger.warn('signed mint: OpenSea calldata differs from our rebuild (sending ours)', { jobId, walletId: w.walletId, note: validation.note });
      await record({ detail: validation.note });
    }

    // 3. Guards before anything irreversible: the abort flag, the per-job spend limit, and the
    // at-most-once marker.
    if (!data.settings.dryRun) {
      if (!this.deps.executionEnabled) return finish('skipped', { reason: 'execution_disabled', detail: 'Kill switch is on.' });
      if (await this.deps.flags.isAborted(jobId)) return finish('skipped', { reason: 'aborted', detail: 'Cancelled before sending.' });
      const limit = data.settings.maxSpendWei === null ? null : BigInt(data.settings.maxSpendWei);
      if (limit !== null && ctx.committedWei + tx.value > limit) {
        return finish('skipped', { reason: 'job_spend_limit', detail: `Would take this job past its ${limit} wei spend limit.`, valueWei: tx.value.toString() });
      }
      // Counted in the same tick as the check: wallets run in parallel, and an await between the two
      // would let several pass against the same total.
      ctx.committedWei += tx.value;
      let claimed = false;
      try {
        claimed = await this.deps.flags.claimSend(jobId, w.walletId);
      } finally {
        if (!claimed) ctx.committedWei -= tx.value;
      }
      if (!claimed) {
        return finish('skipped', { reason: 'already_sent', detail: 'An earlier run of this job already reached the send step for this wallet.' });
      }
    }

    // 4. Simulate (optional), sign, broadcast.
    const steps: AttemptPatch = {};
    // A simulation that says NotActive just after calldata arrives is retried: the eth_call runs
    // against the latest block, which can predate the stage's start.
    let result;
    let sendUnconfirmed = false;
    let notActiveRetries = 0;
    for (;;) {
      try {
        result = await ctx.chain.transactionEngine.executePrepared(
          { chainId: data.chainId, walletId: w.walletId, walletAddress: w.address, ownerId: data.ownerId, spendCapWei: ctx.spendCapWei, walletSpendCapWei: ctx.walletSpendCapWei },
          tx,
          {
            gas: { gas: w.gasLimit, ...ctx.fees },
            simulate: data.settings.simulate,
            dryRun: data.settings.dryRun,
            onStep: (step: PreparedExecutionStep, meta) => {
              if (step === 'simulated') {
                steps.simulatedMs = since();
                if (meta?.simulateMs !== undefined) steps.simulateDurationMs = meta.simulateMs;
              } else if (step === 'signed') steps.signedMs = since();
              else steps.broadcastMs = since();
            },
          },
        );
        break;
      } catch (err) {
        if (isNotActiveSimulation(err) && notActiveRetries < this.timing.notActiveSimRetries) {
          notActiveRetries++;
          await this.clock.sleep(this.timing.notActiveSimRetryMs);
          continue;
        }
        if (err instanceof BroadcastUncertainError) {
          // It may be on its way: keep its value counted and follow the hash like any sent mint.
          result = { kind: 'broadcast' as const, hash: err.hash, nonce: err.nonce };
          sendUnconfirmed = true;
          break;
        }
        if (!data.settings.dryRun) ctx.committedWei -= tx.value;
        const failure = classifyEngineError(err);
        const retried = notActiveRetries > 0 ? ` (simulation retried ${notActiveRetries}x on NotActive first)` : '';
        return finish('failed', { ...steps, reason: failure.reason, detail: `${failure.detail}${retried}`, valueWei: tx.value.toString() });
      }
    }
    if (notActiveRetries > 0) {
      this.deps.logger.info('signed mint: simulation said NotActive before passing', { jobId, walletId: w.walletId, retries: notActiveRetries });
    }
    const retryNote =
      (notActiveRetries > 0 ? ` Simulation said NotActive ${notActiveRetries}x before passing (latest block older than the stage start).` : '') +
      (sendUnconfirmed ? ' The send call failed, so it may not have gone out.' : '');

    if (result.kind === 'dry-run') {
      return finish('dry_run_ok', {
        ...steps,
        valueWei: tx.value.toString(),
        detail:
          (data.settings.simulate ? 'Dry run: simulated successfully, not sent.' : 'Dry run: validated, simulation off, not sent.') +
          (validation.note ? ` ${validation.note}` : '') +
          retryNote,
      });
    }

    await record({
      ...steps,
      status: 'broadcast',
      txHash: result.hash,
      nonce: result.nonce,
      valueWei: tx.value.toString(),
      ...(retryNote ? { detail: `${validation.note ?? ''}${retryNote}`.trim() } : {}),
    });
    void this.deps.auditLogService
      ?.record({
        actorUserId: data.ownerId,
        actorType: 'system',
        action: 'mint.signed',
        walletId: w.walletId,
        targetUserId: data.ownerId,
        outcome: 'success',
        detail: `job ${jobId}, chain ${data.chainId}, contract ${data.nftContract}, qty ${w.quantity}, tx ${result.hash}`,
      })
      .catch(() => undefined);
    // Ledger and vault bookkeeping, same as every other mint: fire-and-forget.
    void this.deps.confirmationWatcher
      ?.enqueue({
        hash: result.hash,
        nonce: result.nonce,
        walletId: w.walletId,
        walletAddress: w.address,
        chainId: data.chainId,
        contract: data.nftContract,
        ownerId: data.ownerId,
        standard: 'erc721',
      })
      .catch(() => undefined);

    // 5. Confirmation, timed here so the report has it.
    try {
      const receipt = await ctx.chain.publicClient.waitForTransactionReceipt({
        hash: result.hash,
        pollingInterval: this.timing.receiptPollMs,
        timeout: this.timing.receiptTimeoutMs,
      });
      return finish(receipt.status === 'success' ? 'confirmed' : 'reverted', {
        confirmedMs: since(),
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: receipt.effectiveGasPrice?.toString() ?? null,
        ...(receipt.status === 'success' ? {} : { reason: 'reverted_onchain', detail: 'The transaction was mined but reverted.' }),
      });
    } catch (err) {
      const waited = `${Math.round(this.timing.receiptTimeoutMs / 1000)}s`;
      return finish('broadcast', { detail: sendUnconfirmed ? `Send outcome unknown: no receipt within ${waited}.` : `Sent, but no receipt within ${waited}: ${message(err)}` });
    }
  }

  /** Asks OpenSea for one wallet's mint calldata until it answers, the wallet is refused for good, or the deadline passes. */
  private async fetchCalldata(
    ctx: JobContext,
    w: WalletRun,
    deadline: number,
  ): Promise<
    | { kind: 'calldata'; calldata: `0x${string}`; openSeaTarget: string | null; counters: CalldataCounters }
    | { kind: 'ended'; status: AttemptStatus; patch: AttemptPatch }
  > {
    const { data, jobId } = ctx;
    const counters: CalldataCounters = { notActiveCount: 0, rateLimitedCount: 0, errorCount: 0, requestCount: 0 };
    let lastProblem = 'OpenSea never returned calldata.';

    type Landed = { id: number; answer: MintCalldataAnswer } | { id: number; paused: true } | { id: number; thrown: unknown };
    const flights = new Map<number, { cancel: AbortController; landed: Promise<Landed> }>();
    let nextId = 0;
    let nextLaunchAt = 0;
    const cancelAll = () => {
      for (const f of flights.values()) f.cancel.abort();
      flights.clear();
    };
    const launch = () => {
      const id = nextId++;
      const cancel = new AbortController();
      const landed = ctx.limiter
        .run(() => {
          counters.requestCount++;
          return this.deps.openSea.requestMintCalldata(data.slug, w.address, w.quantity, AbortSignal.any([cancel.signal, AbortSignal.timeout(this.timing.openSeaRequestTimeoutMs)]));
        }, deadline)
        .then(
          (answer): Landed => ({ id, answer }),
          (err: unknown): Landed => (err instanceof PausedPastDeadlineError ? { id, paused: true } : { id, thrown: err }),
        );
      flights.set(id, { cancel, landed });
    };
    const ended = (status: AttemptStatus, patch: AttemptPatch) => {
      cancelAll();
      return { kind: 'ended' as const, status, patch: { ...patch, ...counters } };
    };

    for (;;) {
      const now = this.clock.now();
      const open = now < deadline;
      if (!open && flights.size === 0) break;
      const overlapping = !ctx.overlapOff && now >= ctx.overlapFrom && now < ctx.overlapUntil;
      const limit = overlapping ? this.deps.overlap!.maxInFlight : 1;

      if (open && flights.size < limit && now >= nextLaunchAt) {
        if (await this.deps.flags.isAborted(jobId)) return ended('skipped', { reason: 'aborted', detail: 'Cancelled before calldata arrived.' });
        launch();
        nextLaunchAt = this.clock.now() + (overlapping ? this.deps.overlap!.intervalMs : 0);
        continue;
      }

      // Wait for an answer, or for the moment the next request is due.
      const waits: Array<Promise<Landed | null>> = [...flights.values()].map((f) => f.landed);
      if (open && flights.size < limit) waits.push(this.clock.sleep(nextLaunchAt - now).then(() => null));
      else if (open && flights.size > 0 && !overlapping && now < ctx.overlapFrom && ctx.overlapFrom < ctx.overlapUntil && !ctx.overlapOff) {
        // One request is out and the overlap window opens before it may answer: wake up for it.
        waits.push(this.clock.sleep(ctx.overlapFrom - now).then(() => null));
      }
      const landed = await Promise.race(waits);
      if (landed === null) continue;
      flights.delete(landed.id);
      if ('thrown' in landed) {
        cancelAll();
        throw landed.thrown;
      }
      if ('paused' in landed) break; // OpenSea asked for a pause longer than this job has left

      const answer = landed.answer;
      if (answer.kind === 'calldata') {
        ctx.limiter.recordSuccess();
        cancelAll();
        return { kind: 'calldata', calldata: answer.calldata, openSeaTarget: answer.to, counters };
      }
      if (answer.kind === 'insufficient_funds') return ended('failed', { reason: answer.kind, detail: answer.message });
      if (answer.kind === 'rate_limited') {
        counters.rateLimitedCount++;
        ctx.limiter.recordRateLimited(answer.retryAfterMs);
        if (!ctx.overlapOff && this.overlapConfigured()) {
          ctx.overlapOff = true;
          this.deps.logger.warn('signed mint: OpenSea rate-limited; back to one request at a time for this job', { jobId, walletId: w.walletId });
        }
        lastProblem = 'OpenSea kept rate-limiting requests.';
        continue; // the limiter itself waits out the pause before the next request
      }
      if (answer.kind === 'not_eligible') {
        // OpenSea judges eligibility against the stage that is active now.
        const { other: otherStageActive, activeStage } = ineligibleForAnotherStage(answer.message, data.stageLabel);
        const active = activeStage === null ? 'another stage' : `"${activeStage}"`;
        if (otherStageActive && data.rehearsal) {
          return ended('failed', {
            reason: 'other_stage_active',
            detail: `OpenSea's active stage is ${active}, not "${data.stageLabel}", and it only checks eligibility for the active stage, so this rehearsal cannot get calldata until "${data.stageLabel}" opens. OpenSea said: ${answer.message}`,
          });
        }
        if (!otherStageActive) return ended('failed', { reason: 'not_eligible', detail: answer.message });
        counters.notActiveCount++;
        lastProblem = `OpenSea's active stage was still ${active}, not "${data.stageLabel}". OpenSea said: ${answer.message}`;
      } else if (answer.kind === 'not_active') {
        counters.notActiveCount++;
        lastProblem = `OpenSea still said: ${answer.message}`;
      } else {
        counters.errorCount++;
        lastProblem = `OpenSea error: ${answer.message}`;
      }
      // One at a time: the usual pause before asking again. Overlapping: the interval already paces it.
      if (!overlapping) nextLaunchAt = Math.max(nextLaunchAt, this.clock.now() + data.settings.retryIntervalMs);
    }
    return ended('failed', { reason: 'gave_up', detail: `Gave up ${Math.round(data.settings.giveUpMs / 1000)}s after T-0. ${lastProblem}` });
  }

  private async abortRun(jobId: string, data: SignedMintJobData, wallets: WalletRun[]): Promise<SignedMintRunResult> {
    for (const w of wallets) {
      await this.mark(
        { jobId, ownerId: data.ownerId, walletId: w.walletId, walletAddress: w.address, quantity: w.quantity },
        { status: 'skipped', reason: 'aborted', detail: 'Cancelled during warm-up.' },
      );
    }
    await this.note(jobId, { status: 'aborted', finishedAt: new Date(this.clock.now()) });
    return { status: 'aborted' };
  }

  private async failAll(jobId: string, data: SignedMintJobData, reason: string, detail: string): Promise<void> {
    for (const w of data.wallets) {
      await this.mark(
        { jobId, ownerId: data.ownerId, walletId: w.walletId, walletAddress: '', quantity: w.quantity },
        { status: reason === 'execution_disabled' ? 'skipped' : 'failed', reason, detail },
      );
    }
  }
}

/** A simulation revert whose decoded SeaDrop reason is NotActive(...): the stage is not open as of the simulated block. */
export function isNotActiveSimulation(err: unknown): boolean {
  if (!(err instanceof SimulationRevertedError) || !err.revertData) return false;
  return decodeSeaDropRevertData(err.revertData)?.startsWith('NotActive') ?? false;
}

/** Same classification MintExecutionService applies to an engine failure. */
export function classifyEngineError(err: unknown): { reason: string; detail: string } {
  if (err instanceof EmergencyStopActiveError) return { reason: 'emergency_stop', detail: `Emergency stop active (${err.stage}).` };
  if (err instanceof SpendingCapExceededError) return { reason: 'spending_cap_exceeded', detail: err.message };
  if (err instanceof RpcUnavailableError) return { reason: 'rpc_unavailable', detail: err.message };
  if (err instanceof SimulationRevertedError) {
    if (isInsufficientFundsFailure(err)) return { reason: 'insufficient_funds', detail: NOT_ENOUGH_FOR_PRICE };
    const decoded = err.revertData ? decodeSeaDropRevertData(err.revertData) : undefined;
    return { reason: 'simulation_reverted', detail: decoded ?? err.message };
  }
  if (isInsufficientFundsFailure(err)) {
    return { reason: 'insufficient_funds', detail: 'Insufficient funds for gas.' };
  }
  return { reason: 'send_failed', detail: message(err) };
}

const message = (err: unknown): string => chainErrorText(err);

function sameUuid(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^0-9a-f]/g, '');
  return n(a) === n(b);
}
