import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import type { UserId } from '@stryx/wallet-service';
import { SignedMintScheduler } from '../src/signed-mint-scheduler.js';
import { InMemorySignedMintRepository } from '../src/signed-mint-repository.js';
import { RedisSignedMintFlags, type SignedMintJobData, type SignedMintRunResult } from '../src/signed-mint-runner.js';
import type { SignedStageResolution } from '../src/signed-mint-start-resolver.js';

/**
 * Real BullMQ against a real Redis: delays, changeDelay, removal, the worker, the owner index and the
 * Redis flags are the parts that fakes cannot vouch for.
 */
const url = process.env['SIGNED_MINT_REDIS_TEST_URL'];
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function jobData(startMs: number, over: Partial<SignedMintJobData> = {}): SignedMintJobData {
  return {
    ownerId: 'owner-1' as UserId,
    chainId: 4663,
    nftContract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768',
    slug: 'kid-story',
    stageUuid: 'stage-1',
    stageLabel: 'FCFS',
    startMs,
    maxPriceWei: '0',
    wallets: [{ walletId: 'w1', quantity: 1 }],
    settings: { simulate: true, dryRun: true, maxSpendWei: null, retryIntervalMs: 250, giveUpMs: 60_000 },
    rehearsal: false,
    ...over,
  };
}

describe.skipIf(!url)('SignedMintScheduler against real Redis + BullMQ', () => {
  let redis: Redis;
  const connection = () => {
    const u = new URL(url!);
    return { host: u.hostname, port: Number(u.port || 6379) };
  };

  beforeAll(async () => {
    redis = new Redis(url!);
    await redis.flushall();
  });
  afterAll(async () => {
    await redis.flushall();
    redis.disconnect();
  });

  it('schedules for T-0 minus the warm-up lead, lists it for its owner only, and cancels a waiting job', async () => {
    const repo = new InMemorySignedMintRepository();
    const scheduler = new SignedMintScheduler(connection(), { run: async () => ({ status: 'aborted' }) }, repo, new RedisSignedMintFlags(redis), redis, silentLogger);
    const startMs = Date.now() + 3_600_000;
    const jobId = await scheduler.schedule(jobData(startMs));

    const [summary] = await scheduler.list({ ownerId: 'owner-1' as UserId });
    expect(summary).toMatchObject({ jobId, state: 'delayed', startMs, totalQuantity: 1, dryRun: true, runStatus: 'scheduled' });
    expect(Math.abs(summary!.executeAt - (startMs - 5_000))).toBeLessThan(1_000);
    expect(await scheduler.list({ ownerId: 'someone-else' as UserId })).toEqual([]);

    expect(await scheduler.cancel(jobId, 'someone-else' as UserId, false)).toBe('not_found');
    expect(await scheduler.cancel(jobId, 'owner-1' as UserId, false)).toBe('cancelled');
    expect(await scheduler.list({ ownerId: 'owner-1' as UserId })).toEqual([]);
    expect((await repo.getRun(jobId))?.status).toBe('cancelled');
    await scheduler.close();
  });

  it('the 30s re-check moves a waiting job when the stage start changes, and leaves it alone otherwise', async () => {
    const startMs = Date.now() + 3_600_000;
    let resolvedStart = startMs;
    const resolveStage = async (): Promise<SignedStageResolution> =>
      ({ ok: true, timing: { startMs: resolvedStart } }) as unknown as SignedStageResolution;
    const repo = new InMemorySignedMintRepository();
    const scheduler = new SignedMintScheduler(connection(), { run: async () => ({ status: 'aborted' }) }, repo, new RedisSignedMintFlags(redis), redis, silentLogger, { resolveStage });
    const jobId = await scheduler.schedule(jobData(startMs));

    expect(await scheduler.recheckOnce()).toEqual([]);

    resolvedStart = startMs + 600_000;
    expect(await scheduler.recheckOnce()).toEqual([{ jobId, from: startMs, to: resolvedStart }]);
    const [summary] = await scheduler.list({ ownerId: 'owner-1' as UserId });
    expect(summary!.startMs).toBe(resolvedStart);
    expect(Math.abs(summary!.executeAt - (resolvedStart - 5_000))).toBeLessThan(1_000);
    expect((await repo.getRun(jobId))?.t0.getTime()).toBe(resolvedStart);

    await scheduler.cancel(jobId, 'owner-1' as UserId, false);
    await scheduler.close();
  });

  it('the worker runs a due job once, and a "moved" result schedules a fresh job at the new start', async () => {
    const calls: string[] = [];
    let result: SignedMintRunResult = { status: 'moved', startMs: Date.now() + 3_600_000 };
    const runner = {
      run: async (jobId: string) => {
        calls.push(jobId);
        const r = result;
        result = { status: 'finished', counts: {} };
        return r;
      },
    };
    const repo = new InMemorySignedMintRepository();
    const scheduler = new SignedMintScheduler(connection(), runner, repo, new RedisSignedMintFlags(redis), redis, silentLogger);
    scheduler.startWorker(connection());
    const firstId = await scheduler.schedule(jobData(Date.now() + 5_000)); // due now: startMs - 5s lead

    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([firstId]);
    await new Promise((r) => setTimeout(r, 200));

    const jobs = await scheduler.list({ ownerId: 'owner-1' as UserId });
    const fresh = jobs.find((j) => j.jobId !== firstId);
    expect(fresh?.state).toBe('delayed');
    expect(jobs.find((j) => j.jobId === firstId)?.state).toBe('completed');
    await scheduler.cancel(fresh!.jobId, 'owner-1' as UserId, false);
    await scheduler.close();
  });

  it('the Redis flags: a send can be claimed once per (job, wallet); abort is seen', async () => {
    const flags = new RedisSignedMintFlags(redis);
    expect(await flags.claimSend('job-x', 'w1')).toBe(true);
    expect(await flags.claimSend('job-x', 'w1')).toBe(false);
    expect(await flags.claimSend('job-x', 'w2')).toBe(true);
    expect(await flags.isAborted('job-x')).toBe(false);
    await flags.abort('job-x');
    expect(await flags.isAborted('job-x')).toBe(true);
  });

  it('cancelling a running job flags it to abort instead of removing it', async () => {
    const repo = new InMemorySignedMintRepository();
    let release: () => void = () => undefined;
    const running = new Promise<void>((r) => (release = r));
    const flags = new RedisSignedMintFlags(redis);
    const scheduler = new SignedMintScheduler(
      connection(),
      {
        run: async () => {
          await running;
          return { status: 'finished', counts: {} };
        },
      },
      repo,
      flags,
      redis,
      silentLogger,
    );
    scheduler.startWorker(connection());
    const jobId = await scheduler.schedule(jobData(Date.now() + 5_000));
    const queue = new Queue('signed-mints', { connection: connection() });
    for (let i = 0; i < 100 && (await queue.getJob(jobId).then((j) => j?.getState())) !== 'active'; i++) await new Promise((r) => setTimeout(r, 50));

    expect(await scheduler.cancel(jobId, 'owner-1' as UserId, false)).toBe('aborting');
    expect(await flags.isAborted(jobId)).toBe(true);
    release();
    await queue.close();
    await scheduler.close();
  });
});
