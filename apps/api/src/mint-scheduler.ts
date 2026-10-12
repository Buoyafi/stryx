import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { UserId } from '@stryx/wallet-service';
import type { Logger } from '@stryx/logger';
import type { MintExecutionService, PublicMintRequest, AllowListMintRequest, MintOutcome, StartPatience } from './mint-execution.service.js';
import type { ChainServices } from './chain-services.js';
import { withTimeout, redactUrls } from '@stryx/utils';

/** The minimal Redis surface the per-owner job index needs; a real ioredis instance satisfies it. */
export interface ScheduleIndexRedisClient {
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

const ownerIndexKey = (ownerId: string): string => `schedule:owner:${ownerId}`;

const QUEUE_NAME = 'scheduled-mints';

/** Carried in job data when a job was auto-scheduled and may self-reschedule if the stage moved. */
export interface AutoRescheduleState {
  remaining: number;
}

/** A scheduled mint job. */
export type ScheduledMintJob = (
  | { kind: 'public'; request: PublicMintRequest }
  | { kind: 'allowlist-stored'; request: Extract<AllowListMintRequest, { proofSource: 'stored' }> }
  | { kind: 'allowlist-opensea'; request: Extract<AllowListMintRequest, { proofSource: 'opensea' }> }
  | {
      kind: 'allowlist-direct';
      request: Omit<Extract<AllowListMintRequest, { proofSource: 'direct' }>, 'mintParams'> & {
        // mintParams with its two bigint fields serialized as strings for Redis
        mintParams: {
          mintPrice: string;
          maxTotalMintableByWallet: number;
          startTime: number;
          endTime: number;
          dropStageIndex: number;
          maxTokenSupplyForStage: string;
          feeBps: number;
          restrictFeeRecipients: boolean;
        };
      };
    }
) & {
  autoReschedule?: AutoRescheduleState;
  /** When the job is due to run (unix ms), kept current by every path that sets or moves it. */
  executeAt?: number;
};

/** What a finished job's mint attempt came to, read from the job's stored return value. */
export interface ScheduledMintOutcome {
  ok: boolean;
  /** A MintFailureReason, when `ok` is false. */
  reason?: string;
  /** The broadcast transaction hash, when `ok` is true. */
  hash?: string;
  detail?: string;
}

export interface ScheduledMintSummary {
  jobId: string;
  kind: ScheduledMintJob['kind'];
  state: string;
  ownerId: UserId;
  walletId: string;
  nftContract: string;
  chainId: number;
  quantity: number;
  /** Unix ms when this job is due to run. */
  executeAt: number;
  /** Present only for auto-scheduled jobs, how many self-reschedules remain. */
  autoRescheduleRemaining?: number;
  failedReason?: string;
  /** Read from the job's stored return value (see ScheduledMintOutcome). */
  outcome?: ScheduledMintOutcome;
}

export interface ScheduleMintParams {
  job: ScheduledMintJob;
  /** Unix ms timestamp to execute at. Past/near-now runs effectively immediately. */
  executeAt: number;
  /** Stable id so a schedule can be cancelled/looked up. Defaults to a generated id. */
  jobId?: string;
  /** When set, the job may self-reschedule up to `remaining` times if it fires before the stage is live. */
  autoReschedule?: AutoRescheduleState;
}

/**
 * Schedules mints for a future time, and runs the worker that fires them through the same
 * MintExecutionService the HTTP endpoints use.
 */
const LEAD_TIME_MS = 2_000;

/** A job whose worker died mid-run is failed, never run again: a mint that had already been sent would otherwise mint twice. */
export const WORKER_SAFETY = { maxStalledCount: 0 } as const;

/** A scheduled job fires LEAD_TIME_MS ahead of its stage. */
export const SCHEDULED_PATIENCE: StartPatience = { waitForStartMs: 5_000, notActiveRetries: 24, notActiveRetryMs: 500 };

/** Jobs run side by side: each wallet has its own nonce sequence, and one job waiting on a stage must not hold back another. */
export const SCHEDULED_MINT_CONCURRENCY = 8;

/** Not yet picked up by the worker. A job that is running (it may be rescheduling itself) does not count. */
const WAITING_STATES = new Set(['delayed', 'waiting', 'waiting-children', 'prioritized', 'paused']);
const TWIN_WINDOW_MS = 5_000;

/** Bounds the reschedule check's chain read: see auto-schedule.service.ts for why this matters. */
const CHAIN_READ_TIMEOUT_MS = 8_000;

export class MintScheduler {
  private readonly queue: Queue<ScheduledMintJob>;
  private worker: Worker<ScheduledMintJob> | undefined;

  constructor(
    connection: ConnectionOptions,
    private readonly mintExecutionService: MintExecutionService,
    private readonly logger: Logger,
    /** A per-owner index of job ids, so `list` and `cancel` only ever see the owner's jobs. */
    private readonly scheduleIndex: ScheduleIndexRedisClient,
    /** Optional: only needed for auto-reschedule (re-reading a moved stage's startTime). */
    private readonly chainServices?: Map<number, ChainServices>,
  ) {
    this.queue = new Queue<ScheduledMintJob>(QUEUE_NAME, { connection });
  }

  async schedule(params: ScheduleMintParams): Promise<string> {
    const now = Date.now();
    const delay = Math.max(0, params.executeAt - now);
    const jobData: ScheduledMintJob = {
      ...params.job,
      ...(params.autoReschedule ? { autoReschedule: params.autoReschedule } : {}),
      executeAt: now + delay,
    };
    const job = await this.queue.add('mint', jobData, {
      delay,
      ...(params.jobId ? { jobId: params.jobId } : {}),
      // No automatic retry: a failed mint should not fire again later against changed chain state.
      attempts: 1,
      removeOnComplete: { age: 86_400 }, // keep completed job records 24h for inspection
      removeOnFail: { age: 86_400 },
    });
    // Best effort: BullMQ already has the job; a missing index entry only hides it from the owner's
    // list.
    try {
      await this.scheduleIndex.sadd(ownerIndexKey(params.job.request.ownerId), job.id ?? '');
    } catch (err) {
      this.logger.error('failed to index scheduled job by owner', {
        jobId: job.id,
        ownerId: params.job.request.ownerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    this.logger.info('mint scheduled', { jobId: job.id, delayMs: delay, kind: params.job.kind });
    return job.id ?? '';
  }

  /** Lists scheduled mints that haven't run yet, plus recently finished ones. */
  async list(scope: { ownerId: UserId } | { all: true }): Promise<ScheduledMintSummary[]> {
    if ('all' in scope) {
      const jobs = await this.queue.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed'], 0, 100);
      const summaries = await Promise.all(jobs.map(async (job) => summarizeJob(job, await job.getState())));
      return summaries.sort((a, b) => a.executeAt - b.executeAt);
    }

    const ids = await this.scheduleIndex.smembers(ownerIndexKey(scope.ownerId));
    const jobs = await Promise.all(
      ids.map(async (id) => {
        const job = await this.queue.getJob(id);
        // The index can go stale: BullMQ prunes finished jobs after 24h.
        if (!job) {
          await this.scheduleIndex.srem(ownerIndexKey(scope.ownerId), id).catch(() => undefined);
          return undefined;
        }
        return job;
      }),
    );

    const summaries = await Promise.all(
      jobs.filter((job): job is NonNullable<typeof job> => job !== undefined).map(async (job) => summarizeJob(job, await job.getState())),
    );
    return summaries.sort((a, b) => a.executeAt - b.executeAt);
  }

  /** Whether a job with this id is still on record. */
  async exists(jobId: string): Promise<boolean> {
    return (await this.queue.getJob(jobId)) !== undefined;
  }

  /**
   * Whether this owner already has a job waiting to mint the same stage of the same drop from the same
   * wallet at (near enough) the same time.
   */
  async hasPendingTwin(job: ScheduledMintJob, executeAt: number): Promise<boolean> {
    const { ownerId, walletId, chainId, nftContract } = job.request;
    const mine = await this.list({ ownerId });
    return mine.some(
      (j) =>
        WAITING_STATES.has(j.state) &&
        j.walletId === walletId &&
        (j.kind === 'public') === (job.kind === 'public') &&
        j.chainId === chainId &&
        j.nftContract.toLowerCase() === nftContract.toLowerCase() &&
        Math.abs(j.executeAt - executeAt) <= TWIN_WINDOW_MS,
    );
  }

  /** Cancels a scheduled job, only for its owner or an admin. */
  async cancel(jobId: string, ownerId: UserId, isAdmin: boolean): Promise<'cancelled' | 'not_found' | 'running'> {
    const job = await this.queue.getJob(jobId);
    if (!job) return 'not_found';
    if (!isAdmin && job.data.request.ownerId !== ownerId) return 'not_found';
    // A job a worker holds cannot be removed (BullMQ throws): it is minting now, too late to cancel.
    if ((await job.getState()) === 'active') return 'running';
    try {
      await job.remove();
    } catch {
      return 'running'; // picked up between the state read and the remove
    }
    await this.scheduleIndex.srem(ownerIndexKey(job.data.request.ownerId), jobId).catch(() => undefined);
    this.logger.info('scheduled mint cancelled', { jobId, ownerId: job.data.request.ownerId, cancelledBy: ownerId, asAdmin: isAdmin });
    return 'cancelled';
  }

  /** Edits a pending job's quantity or time in place, instead of cancel and re-schedule under the same id. */
  async updateJob(
    jobId: string,
    ownerId: UserId,
    params: { quantity?: number; executeAt?: number },
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_editable' }> {
    // The cast is needed because `getJob` returns BullMQ's internal default job type.
    const job = (await this.queue.getJob(jobId)) as Job<ScheduledMintJob> | undefined;
    if (!job) return { ok: false, reason: 'not_found' };
    if (job.data.request.ownerId !== ownerId) return { ok: false, reason: 'not_found' };

    const state = await job.getState();
    if (state !== 'delayed' && state !== 'waiting') return { ok: false, reason: 'not_editable' };

    // The time first, then both changes in one write: a refused time change must not leave the new
    // quantity applied.
    let next = params.quantity !== undefined ? withQuantity(job.data, params.quantity) : job.data;
    if (params.executeAt !== undefined) {
      const now = Date.now();
      const delay = Math.max(0, params.executeAt - now);
      try {
        await job.changeDelay(delay);
      } catch {
        // The job left 'delayed' in the gap since the state check: refuse cleanly.
        return { ok: false, reason: 'not_editable' };
      }
      // Recorded on the job, since BullMQ's own fields keep the pre-edit time: see ScheduledMintJob.executeAt.
      next = { ...next, executeAt: now + delay };
    }
    if (next !== job.data) await job.updateData(next);

    this.logger.info('scheduled mint updated', {
      jobId,
      ownerId,
      quantity: params.quantity,
      executeAt: params.executeAt,
    });
    return { ok: true };
  }

  /** Starts the worker that executes due jobs. Call once at startup. */
  startWorker(connection: ConnectionOptions): void {
    if (this.worker) return;
    this.worker = new Worker<ScheduledMintJob>(
      QUEUE_NAME,
      async (job: Job<ScheduledMintJob>) => this.process(job.data, job.id),
      { connection, concurrency: SCHEDULED_MINT_CONCURRENCY, ...WORKER_SAFETY },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error('scheduled mint job failed', { jobId: job?.id, message: err.message });
    });
  }

  private async process(data: ScheduledMintJob, jobId?: string): Promise<MintOutcome> {
    const outcome = await this.runJob(data, jobId);

    // Self-reschedule: an auto-scheduled public mint fired before its stage was live (the start was
    // pushed back).
    if (
      !outcome.ok &&
      outcome.reason === 'no_active_public_stage' &&
      data.kind === 'public' &&
      data.autoReschedule &&
      data.autoReschedule.remaining > 0 &&
      this.chainServices
    ) {
      const rescheduled = await this.tryReschedule(data, data.autoReschedule.remaining);
      if (rescheduled) {
        this.logger.info('auto-scheduled mint rescheduled: stage moved', {
          remaining: data.autoReschedule.remaining - 1,
        });
        return outcome; // this run is done; a new job now carries the mint forward
      }
    }

    this.logger.info('scheduled mint executed', {
      kind: data.kind,
      ok: outcome.ok,
      reason: outcome.ok ? undefined : outcome.reason,
      hash: outcome.ok ? outcome.result.hash : undefined,
    });
    return outcome;
  }

  /**
   * Re-reads the public drop's startTime and, if it's now in the future, schedules a fresh job for it
   * with the reschedule counter decremented.
   */
  private async tryReschedule(
    data: Extract<ScheduledMintJob, { kind: 'public' }>,
    remaining: number,
  ): Promise<boolean> {
    const chain = this.chainServices?.get(data.request.chainId);
    if (!chain) return false;

    const scope = { nftContract: data.request.nftContract, chainId: data.request.chainId };
    let drop;
    try {
      drop = await withTimeout(
        chain.seaDropReader.getPublicDrop(scope),
        CHAIN_READ_TIMEOUT_MS,
        `getPublicDrop (chain ${data.request.chainId})`,
      );
    } catch (err) {
      // No new start time could be confirmed: give up this round instead of letting an unresponsive
      // RPC hang the worker.
      this.logger.error('reschedule chain read failed', {
        chainId: data.request.chainId,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (drop.startTime === 0 || drop.startTime <= nowSec) return false; // no future start to aim at

    await this.schedule({
      job: { kind: 'public', request: data.request },
      executeAt: drop.startTime * 1000 - LEAD_TIME_MS,
      autoReschedule: { remaining: remaining - 1 },
    });
    return true;
  }

  private async runJob(data: ScheduledMintJob, jobId?: string): Promise<MintOutcome> {
    return dispatchScheduledMint(this.mintExecutionService, data, jobId);
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

/** The list's view of one BullMQ job. */
export function summarizeJob(
  job: Pick<Job<ScheduledMintJob>, 'id' | 'data' | 'timestamp' | 'opts' | 'failedReason' | 'returnvalue'>,
  state: string,
): ScheduledMintSummary {
  const data = job.data;
  return {
    jobId: job.id ?? '',
    kind: data.kind,
    state,
    ownerId: data.request.ownerId,
    walletId: data.request.walletId,
    nftContract: data.request.nftContract,
    chainId: data.request.chainId,
    quantity: data.request.quantity,
    // The job's own record of when it is due (kept current across edits).
    executeAt: data.executeAt ?? job.timestamp + (job.opts.delay ?? 0),
    ...(data.autoReschedule ? { autoRescheduleRemaining: data.autoReschedule.remaining } : {}),
    ...(job.failedReason ? { failedReason: redactUrls(job.failedReason) } : {}),
    ...outcomeField(job.returnvalue),
  };
}

/** Reads a job's stored return value (the MintOutcome the worker returned) into the small shape the list exposes. */
export function summarizeOutcome(returnvalue: unknown): ScheduledMintOutcome | undefined {
  if (typeof returnvalue !== 'object' || returnvalue === null) return undefined;
  const v = returnvalue as { ok?: unknown; result?: { hash?: unknown }; reason?: unknown; detail?: unknown };
  if (v.ok === true) {
    const hash = v.result?.hash;
    return typeof hash === 'string' ? { ok: true, hash } : { ok: true };
  }
  if (v.ok === false) {
    return {
      ok: false,
      ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
      ...(typeof v.detail === 'string' ? { detail: redactUrls(v.detail) } : {}),
    };
  }
  return undefined;
}

function outcomeField(returnvalue: unknown): { outcome?: ScheduledMintOutcome } {
  const outcome = summarizeOutcome(returnvalue);
  return outcome ? { outcome } : {};
}

/** Returns a job with its quantity replaced, keeping `kind` paired with its own `request` shape. */
function withQuantity(job: ScheduledMintJob, quantity: number): ScheduledMintJob {
  switch (job.kind) {
    case 'public':
      return { ...job, request: { ...job.request, quantity } };
    case 'allowlist-stored':
      return { ...job, request: { ...job.request, quantity } };
    case 'allowlist-opensea':
      return { ...job, request: { ...job.request, quantity } };
    case 'allowlist-direct':
      return { ...job, request: { ...job.request, quantity } };
  }
}

/** Maps a queued job to the right MintExecutionService call, turning the mintParams strings stored in Redis back into bigints. */
export async function dispatchScheduledMint(
  mintExecutionService: MintExecutionService,
  job: ScheduledMintJob,
  /** The queue's id for this job: the mint log groups a scheduled run by it. */
  jobId?: string,
): Promise<MintOutcome> {
  // Fired by the scheduler, whatever the stored request said: the mint log's `source` comes from where
  // the mint entered.
  const data = { ...job, request: { ...job.request, source: 'SCHEDULED' as const, ...(jobId ? { jobId } : {}) } } as ScheduledMintJob;
  switch (data.kind) {
    case 'public':
      return mintExecutionService.executePublicMint(data.request, SCHEDULED_PATIENCE);
    case 'allowlist-stored':
      return mintExecutionService.executeAllowListMint(data.request, SCHEDULED_PATIENCE);
    case 'allowlist-opensea':
      // Resolved when the job fires, not when it was scheduled: the same fetch and on-chain check an
      // immediate mint does.
      return mintExecutionService.executeAllowListMint(data.request, SCHEDULED_PATIENCE);
    case 'allowlist-direct':
      return mintExecutionService.executeAllowListMint(
        {
          ...data.request,
          proofSource: 'direct',
          mintParams: {
            mintPrice: BigInt(data.request.mintParams.mintPrice),
            maxTotalMintableByWallet: data.request.mintParams.maxTotalMintableByWallet,
            startTime: data.request.mintParams.startTime,
            endTime: data.request.mintParams.endTime,
            dropStageIndex: data.request.mintParams.dropStageIndex,
            maxTokenSupplyForStage: BigInt(data.request.mintParams.maxTokenSupplyForStage),
            feeBps: data.request.mintParams.feeBps,
            restrictFeeRecipients: data.request.mintParams.restrictFeeRecipients,
          },
        },
        SCHEDULED_PATIENCE,
      );
  }
}
