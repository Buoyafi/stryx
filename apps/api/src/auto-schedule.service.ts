import type { Logger } from '@stryx/logger';
import type { ChainServices } from './chain-services.js';
import type { MintScheduler, ScheduledMintJob } from './mint-scheduler.js';
import { withTimeout, withRetry, isRpcTransportFailure } from '@stryx/utils';

/**
 * Reads a drop's stage start time from the chain and schedules a mint for when the stage opens, so a
 * caller need not supply a timestamp.
 */

/** How early before startTime to fire, so the mint flow's fresh re-check + simulate happens right as the stage opens. */
const LEAD_TIME_MS = 2_000;

/** Bounds each attempt of the `getPublicDrop` read. */
const CHAIN_READ_TIMEOUT_MS = 8_000;

/**
 * Scheduling often happens days ahead, where a failed read is cheap to retry: several attempts before
 * reporting chain_unavailable.
 */
const SCHEDULE_READ_RETRY_ATTEMPTS = 5;
const SCHEDULE_READ_RETRY_DELAY_MS = 500;

export interface AutoScheduleResult {
  scheduled: boolean;
  jobId?: string;
  startTimeUnix?: number;
  reason?: 'no_start_time' | 'stage_already_ended' | 'chain_unavailable' | 'already_scheduled';
}

export class AutoScheduleService {
  constructor(
    private readonly chainServices: Map<number, ChainServices>,
    private readonly mintScheduler: MintScheduler,
    private readonly logger: Logger,
  ) {}

  /** Reads the public stage's startTime for a drop and schedules a public mint for it. */
  async autoSchedulePublicMint(
    job: Extract<ScheduledMintJob, { kind: 'public' }>,
    maxReschedules = 5,
  ): Promise<AutoScheduleResult> {
    const chain = this.chainServices.get(job.request.chainId);
    if (!chain) {
      // Caller should have validated chain support already; treat as no-op here.
      return { scheduled: false, reason: 'no_start_time' };
    }

    const scope = { nftContract: job.request.nftContract, chainId: job.request.chainId };
    let drop;
    try {
      drop = await withRetry(
        () => withTimeout(chain.seaDropReader.getPublicDrop(scope), CHAIN_READ_TIMEOUT_MS, `getPublicDrop (chain ${job.request.chainId})`),
        { attempts: SCHEDULE_READ_RETRY_ATTEMPTS, delayMs: SCHEDULE_READ_RETRY_DELAY_MS, isRetryable: isRpcTransportFailure },
      );
    } catch (err) {
      this.logger.error('auto-schedule chain read failed', {
        chainId: job.request.chainId,
        nftContract: job.request.nftContract,
        message: err instanceof Error ? err.message : String(err),
      });
      return { scheduled: false, reason: 'chain_unavailable' };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    // startTime === 0 means "not configured" per SeaDrop; not a real time.
    if (drop.startTime === 0) return { scheduled: false, reason: 'no_start_time' };
    if (drop.endTime !== 0 && drop.endTime <= nowSec) return { scheduled: false, reason: 'stage_already_ended' };

    const executeAt = drop.startTime * 1000 - LEAD_TIME_MS;
    // The price read here is the one being agreed to, unless the caller set a ceiling of their own.
    const priced = { ...job, request: { ...job.request, maxPriceWei: job.request.maxPriceWei ?? drop.mintPrice.toString() } };
    if (await this.mintScheduler.hasPendingTwin(priced, executeAt)) return { scheduled: false, reason: 'already_scheduled' };
    const jobId = await this.mintScheduler.schedule({
      job: priced,
      executeAt,
      autoReschedule: { remaining: maxReschedules },
    });

    this.logger.info('auto-scheduled public mint', {
      jobId,
      startTimeUnix: drop.startTime,
      chainId: job.request.chainId,
    });

    return { scheduled: true, jobId, startTimeUnix: drop.startTime };
  }
}
