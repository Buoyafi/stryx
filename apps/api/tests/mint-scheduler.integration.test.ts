import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { UserId } from '@stryx/wallet-service';
import { MintScheduler } from '../src/mint-scheduler.js';

/** Real BullMQ against a real Redis, for the one thing fakes cannot vouch for: what the list reports after `changeDelay`. */
const url = process.env['SIGNED_MINT_REDIS_TEST_URL'];
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const OWNER = 'owner-1' as UserId;

describe.skipIf(!url)('MintScheduler against real Redis + BullMQ', () => {
  let redis: Redis;
  beforeAll(async () => {
    redis = new Redis(url!);
    await redis.flushall();
  });
  afterAll(async () => {
    await redis.flushall();
    redis.disconnect();
  });

  it('after editing a scheduled job\'s time, the list shows the NEW time (it used to keep showing the old one)', async () => {
    const u = new URL(url!);
    const scheduler = new MintScheduler({ host: u.hostname, port: Number(u.port || 6379) }, {} as never, silentLogger, redis);
    const first = Date.now() + 3_600_000;
    const jobId = await scheduler.schedule({
      job: { kind: 'public', request: { ownerId: OWNER, walletId: 'w1', nftContract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768', chainId: 4663, quantity: 1 } },
      executeAt: first,
    });
    const before = (await scheduler.list({ ownerId: OWNER })).find((j) => j.jobId === jobId)!;
    expect(Math.abs(before.executeAt - first)).toBeLessThan(1_000);

    const moved = Date.now() + 7_200_000;
    expect(await scheduler.updateJob(jobId, OWNER, { executeAt: moved })).toEqual({ ok: true });
    const after = (await scheduler.list({ ownerId: OWNER })).find((j) => j.jobId === jobId)!;
    expect(Math.abs(after.executeAt - moved)).toBeLessThan(1_000);

    // A quantity-only edit keeps the time it had.
    await scheduler.updateJob(jobId, OWNER, { quantity: 2 });
    const again = (await scheduler.list({ ownerId: OWNER })).find((j) => j.jobId === jobId)!;
    expect(again.quantity).toBe(2);
    expect(Math.abs(again.executeAt - moved)).toBeLessThan(1_000);

    await scheduler.cancel(jobId, OWNER, false);
    await scheduler.close();
  });

  it('a refused time change leaves the quantity as it was', async () => {
    const u = new URL(url!);
    const scheduler = new MintScheduler({ host: u.hostname, port: Number(u.port || 6379) }, {} as never, silentLogger, redis);
    const jobId = await scheduler.schedule({
      job: { kind: 'public', request: { ownerId: OWNER, walletId: 'w1', nftContract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768', chainId: 4663, quantity: 1 } },
      executeAt: Date.now() + 3_600_000,
    });
    // Moved out of 'delayed' after the state check: changeDelay then throws.
    const queue = (scheduler as unknown as { queue: { getJob(id: string): Promise<{ getState(): Promise<string>; changeDelay(): Promise<void> } | undefined> } }).queue;
    const realGetJob = queue.getJob.bind(queue);
    queue.getJob = async (id: string) => {
      const job = await realGetJob(id);
      if (job) job.changeDelay = async () => { throw new Error('Job is not in the delayed state'); };
      return job;
    };

    expect(await scheduler.updateJob(jobId, OWNER, { quantity: 5, executeAt: Date.now() + 7_200_000 })).toEqual({ ok: false, reason: 'not_editable' });
    queue.getJob = realGetJob;
    const job = (await scheduler.list({ ownerId: OWNER })).find((j) => j.jobId === jobId)!;
    expect(job.quantity).toBe(1);

    await scheduler.cancel(jobId, OWNER, false);
    await scheduler.close();
  });

  it('cancelling a job a worker is running answers "running" instead of throwing', async () => {
    const u = new URL(url!);
    let release!: () => void;
    let markStarted!: () => void;
    const running = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (markStarted = r));
    const mintExecutionService = {
      executePublicMint: async () => {
        markStarted();
        await running;
        return { ok: false, reason: 'test', detail: null };
      },
    };
    const scheduler = new MintScheduler({ host: u.hostname, port: Number(u.port || 6379) }, mintExecutionService as never, silentLogger, redis);
    scheduler.startWorker({ host: u.hostname, port: Number(u.port || 6379) });
    const jobId = await scheduler.schedule({
      job: { kind: 'public', request: { ownerId: OWNER, walletId: 'w1', nftContract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768', chainId: 4663, quantity: 1 } },
      executeAt: Date.now(),
    });
    await started;

    expect(await scheduler.cancel(jobId, OWNER, false)).toBe('running');
    release();
    await scheduler.close();
  });
});
