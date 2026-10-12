import { copySignedRunToMintLog } from './signed-mint-history.js';
import type { MintEventRepository } from './mint-event-log.js';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { UserId } from '@stryx/wallet-service';
import type { Logger } from '@stryx/logger';
import type { ScheduleIndexRedisClient } from './mint-scheduler.js';
import type { SignedMintFlags, SignedMintJobData, SignedMintRunResult, SignedMintRunner } from './signed-mint-runner.js';
import { DEFAULT_RUNNER_TIMING } from './signed-mint-runner.js';
import type { SignedMintRepository, SignedMintRunRow } from './signed-mint-repository.js';
import type { SignedStageResolution } from './signed-mint-start-resolver.js';

const QUEUE_NAME = 'signed-mints';
const ownerIndexKey = (ownerId: string): string => `signed-schedule:owner:${ownerId}`;

/** Re-read OpenSea's start time this often for every job still waiting. */
export const RECHECK_INTERVAL_MS = 30_000;
/** A start that moved by less than this is treated as unchanged. */
const MOVE_THRESHOLD_MS = 1_000;

export interface SignedMintJobSummary {
  jobId: string;
  state: string;
  ownerId: UserId;
  chainId: number;
  nftContract: string;
  slug: string;
  stageUuid: string;
  stageLabel: string;
  /** T-0, unix ms. */
  startMs: number;
  /** When the job itself fires (warm-up), unix ms. */
  executeAt: number;
  wallets: Array<{ walletId: string; quantity: number }>;
  totalQuantity: number;
  dryRun: boolean;
  simulate: boolean;
  rehearsal: boolean;
  /** Fired straight away on a stage that was already live ("Mint now"). */
  immediate: boolean;
  /** The run's own status from the event log once warm-up has begun, else null. */
  runStatus: string | null;
}

export type CancelResult = 'cancelled' | 'aborting' | 'not_found' | 'not_cancellable';

export interface SignedMintSchedulerOptions {
  /** The mint log: each finished run is copied into it (signed-mint-history.ts). */
  mintLog?: MintEventRepository;
  /** Re-reads the stage for the 30s re-check. Omit to disable the re-check. */
  resolveStage?: (data: SignedMintJobData) => Promise<SignedStageResolution>;
  now?: () => number;
  warmupLeadMs?: number;
}

/** Schedules signed-mint jobs and runs them. */
export class SignedMintScheduler {
  private readonly queue: Queue<SignedMintJobData>;
  private worker: Worker<SignedMintJobData> | undefined;
  private recheckTimer: NodeJS.Timeout | undefined;
  private rechecking = false;
  private readonly now: () => number;
  private readonly warmupLeadMs: number;

  constructor(
    connection: ConnectionOptions,
    private readonly runner: Pick<SignedMintRunner, 'run'>,
    private readonly repository: SignedMintRepository,
    private readonly flags: SignedMintFlags,
    private readonly index: ScheduleIndexRedisClient,
    private readonly logger: Logger,
    private readonly options: SignedMintSchedulerOptions = {},
    queue?: Queue<SignedMintJobData>,
  ) {
    this.queue = queue ?? new Queue<SignedMintJobData>(QUEUE_NAME, { connection });
    this.now = options.now ?? Date.now;
    this.warmupLeadMs = options.warmupLeadMs ?? DEFAULT_RUNNER_TIMING.warmupLeadMs;
  }

  async schedule(data: SignedMintJobData): Promise<string> {
    const jobId = `signed-${randomUUID()}`;
    const delay = Math.max(0, data.startMs - this.warmupLeadMs - this.now());
    // The run row first: if it cannot be written nothing is queued, so a retry cannot put two jobs on
    // the same stage.
    await this.repository.upsertRun({
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
      status: 'scheduled',
    });
    try {
      await this.queue.add('signed-mint', data, {
        jobId,
        delay,
        attempts: 1,
        removeOnComplete: { age: 7 * 86_400 },
        removeOnFail: { age: 7 * 86_400 },
      });
    } catch (err) {
      await this.repository.updateRun(jobId, { status: 'cancelled', finishedAt: new Date(this.now()), notes: 'could not be queued' }).catch(() => undefined);
      throw err;
    }
    await this.index.sadd(ownerIndexKey(data.ownerId), jobId).catch((err: unknown) => {
      this.logger.error('failed to index signed mint job by owner', { jobId, message: err instanceof Error ? err.message : String(err) });
    });
    this.logger.info('signed mint scheduled', { jobId, startMs: data.startMs, delayMs: delay, wallets: data.wallets.length, dryRun: data.settings.dryRun });
    return jobId;
  }

  async list(scope: { ownerId: UserId } | { all: true }): Promise<SignedMintJobSummary[]> {
    let jobs: Array<Job<SignedMintJobData>>;
    if ('all' in scope) {
      jobs = (await this.queue.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed'], 0, 200)) as Array<Job<SignedMintJobData>>;
    } else {
      const ids = await this.index.smembers(ownerIndexKey(scope.ownerId));
      const found = await Promise.all(
        ids.map(async (id) => {
          const job = (await this.queue.getJob(id)) as Job<SignedMintJobData> | undefined;
          if (!job) await this.index.srem(ownerIndexKey(scope.ownerId), id).catch(() => undefined);
          return job;
        }),
      );
      jobs = found.filter((j): j is Job<SignedMintJobData> => j !== undefined);
    }
    const summaries = await Promise.all(
      jobs.map(async (job) => summarize(job, await job.getState(), await this.repository.getRun(job.id ?? '').catch(() => null), this.warmupLeadMs)),
    );
    return summaries.sort((a, b) => a.startMs - b.startMs);
  }

  /** The job's data, for its owner (or an admin) only: not found and not yours look the same. */
  async get(jobId: string, ownerId: UserId, isAdmin: boolean): Promise<SignedMintJobData | null> {
    const job = (await this.queue.getJob(jobId)) as Job<SignedMintJobData> | undefined;
    if (!job) return null;
    if (!isAdmin && job.data.ownerId !== ownerId) return null;
    return job.data;
  }

  /** A waiting job is removed. */
  async cancel(jobId: string, ownerId: UserId, isAdmin: boolean): Promise<CancelResult> {
    const job = (await this.queue.getJob(jobId)) as Job<SignedMintJobData> | undefined;
    if (!job) return 'not_found';
    if (!isAdmin && job.data.ownerId !== ownerId) return 'not_found';
    const state = await job.getState();
    if (state === 'delayed' || state === 'waiting') {
      await job.remove();
      await this.index.srem(ownerIndexKey(job.data.ownerId), jobId).catch(() => undefined);
      await this.repository.updateRun(jobId, { status: 'cancelled', finishedAt: new Date(this.now()) }).catch(() => undefined);
      this.logger.info('signed mint cancelled', { jobId, cancelledBy: ownerId });
      return 'cancelled';
    }
    if (state === 'active') {
      await this.flags.abort(jobId);
      this.logger.warn('signed mint abort requested mid-run', { jobId, requestedBy: ownerId });
      return 'aborting';
    }
    return 'not_cancellable';
  }

  startWorker(connection: ConnectionOptions, concurrency = 5): void {
    if (this.worker) return;
    this.worker = new Worker<SignedMintJobData>(QUEUE_NAME, async (job) => this.process(job.id ?? '', job.data), {
      connection,
      concurrency,
      // A stalled job (its worker died or blocked mid-run) is failed, never re-run.
      maxStalledCount: 0,
    });
    // Reached when a run threw, and when a job is failed for stalling (its worker died mid-run).
    this.worker.on('failed', (job, err) => {
      this.logger.error('signed mint job failed', { jobId: job?.id, message: err.message });
      if (job?.id) void this.finalizeInterrupted(job.id);
    });
  }

  /** Closes the books on a run that stopped without finishing. */
  async finalizeInterrupted(jobId: string): Promise<void> {
    try {
      const run = await this.repository.getRun(jobId);
      if (!run || run.finishedAt) return;
      for (const a of await this.repository.listAttempts(jobId)) {
        if (a.status !== 'pending') continue;
        await this.repository.upsertAttempt(
          { jobId, ownerId: a.ownerId, walletId: a.walletId, walletAddress: a.walletAddress, quantity: a.quantity },
          { status: 'failed', reason: 'interrupted', detail: 'The run stopped before this wallet had an outcome. Check the wallet before retrying.' },
        );
      }
      await this.repository.updateRun(jobId, { status: 'finished', finishedAt: new Date(this.now()), notes: [run.notes, 'interrupted: the run stopped before it finished'].filter(Boolean).join('\n') });
      if (this.options.mintLog) await copySignedRunToMintLog({ signed: this.repository, mintLog: this.options.mintLog, logger: this.logger }, jobId);
      this.logger.warn('signed mint run finalised after an interruption', { jobId });
    } catch (err) {
      this.logger.error('signed mint: could not finalise an interrupted run', { jobId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async process(jobId: string, data: SignedMintJobData): Promise<SignedMintRunResult> {
    const result = await this.runner.run(jobId, data);
    if ((result.status === 'finished' || result.status === 'aborted') && this.options.mintLog) {
      await copySignedRunToMintLog({ signed: this.repository, mintLog: this.options.mintLog, logger: this.logger }, jobId).catch((err: unknown) => {
        this.logger.error('mint log: could not copy the signed run', { jobId, err: err instanceof Error ? err.message : String(err) });
      });
    }
    if (result.status === 'moved') {
      const newId = await this.schedule({ ...data, startMs: result.startMs });
      await this.repository.updateRun(jobId, { notes: `moved: rescheduled as ${newId}` }).catch(() => undefined);
    }
    return result;
  }

  /** Starts the 30s start-time re-check. No-op when no `resolveStage` was given. */
  startRecheck(intervalMs = RECHECK_INTERVAL_MS): void {
    if (this.recheckTimer || !this.options.resolveStage) return;
    this.recheckTimer = setInterval(() => {
      // A pass reads OpenSea once per job and can outlast the interval: never two at once.
      if (this.rechecking) return;
      this.rechecking = true;
      void this.recheckOnce()
        .catch((err: unknown) => {
          this.logger.error('signed mint re-check failed', { message: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          this.rechecking = false;
        });
    }, intervalMs);
  }

  /** Re-reads every waiting job's stage start (OpenSea, cross-checked on-chain). */
  async recheckOnce(): Promise<Array<{ jobId: string; from: number; to: number }>> {
    const resolve = this.options.resolveStage;
    if (!resolve) return [];
    const moved: Array<{ jobId: string; from: number; to: number }> = [];
    const jobs = (await this.queue.getJobs(['delayed'], 0, 200)) as Array<Job<SignedMintJobData>>;
    for (const job of jobs) {
      if (job.data.rehearsal || job.data.immediate) continue;
      const res = await resolve(job.data).catch(() => null);
      if (!res) continue;
      if (!res.ok) {
        this.logger.warn('signed mint re-check: stage no longer resolves', { jobId: job.id, reason: res.reason, detail: res.detail });
        continue;
      }
      const to = res.timing.startMs;
      const from = job.data.startMs;
      if (Math.abs(to - from) < MOVE_THRESHOLD_MS) continue;
      try {
        // The delay first: if the job just left 'delayed' this throws before its stored T-0 changes.
        await job.changeDelay(Math.max(0, to - this.warmupLeadMs - this.now()));
        await job.updateData({ ...job.data, startMs: to });
        await this.repository.updateRun(job.id ?? '', { t0: new Date(to), notes: `start moved from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}` }).catch(() => undefined);
        moved.push({ jobId: job.id ?? '', from, to });
        this.logger.info('signed mint moved: stage start changed', { jobId: job.id, from, to });
      } catch (err) {
        // The job left 'delayed' between the read and the move (it just started): its own warm-up
        // re-reads the start.
        this.logger.warn('signed mint re-check could not move job', { jobId: job.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return moved;
  }

  async close(): Promise<void> {
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    await this.worker?.close();
    await this.queue.close();
  }
}

/**
 * `executeAt` comes from the job's own `startMs`, never from BullMQ's `timestamp + delay`, which a
 * moved job no longer reflects.
 */
export function summarize(
  job: Pick<Job<SignedMintJobData>, 'id' | 'data'>,
  state: string,
  run: SignedMintRunRow | null,
  warmupLeadMs: number = DEFAULT_RUNNER_TIMING.warmupLeadMs,
): SignedMintJobSummary {
  const d = job.data;
  return {
    jobId: job.id ?? '',
    state,
    ownerId: d.ownerId,
    chainId: d.chainId,
    nftContract: d.nftContract,
    slug: d.slug,
    stageUuid: d.stageUuid,
    stageLabel: d.stageLabel,
    startMs: d.startMs,
    executeAt: d.startMs - warmupLeadMs,
    wallets: d.wallets,
    totalQuantity: d.wallets.reduce((n, w) => n + w.quantity, 0),
    dryRun: d.settings.dryRun,
    simulate: d.settings.simulate,
    rehearsal: d.rehearsal,
    immediate: d.immediate ?? false,
    runStatus: run?.status ?? null,
  };
}
