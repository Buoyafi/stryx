import { describe, expect, it } from 'vitest';
import type { UserId } from '@stryx/wallet-service';
import { SignedMintScheduler } from '../src/signed-mint-scheduler.js';
import { InMemorySignedMintRepository } from '../src/signed-mint-repository.js';
import type { SignedMintJobData } from '../src/signed-mint-runner.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const flags = { claimSend: async () => true, isAborted: async () => false, abort: async () => undefined };
const index = { sadd: async () => 1, srem: async () => 1, smembers: async () => [] };

const data: SignedMintJobData = {
  ownerId: 'owner-1' as UserId,
  chainId: 4663,
  nftContract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768',
  slug: 'kid-story',
  stageUuid: 'stage-1',
  stageLabel: 'FCFS',
  startMs: Date.now() + 60_000,
  maxPriceWei: '0',
  wallets: [{ walletId: 'w1', quantity: 1 }],
  settings: { simulate: true, dryRun: false, maxSpendWei: null, retryIntervalMs: 250, giveUpMs: 60_000 },
  rehearsal: false,
};

function rig(opts: { addFails?: boolean } = {}) {
  const repository = new InMemorySignedMintRepository();
  const queued: string[] = [];
  const queue = {
    add: async (_name: string, _data: unknown, o: { jobId: string }) => {
      if (opts.addFails) throw new Error('redis down');
      queued.push(o.jobId);
    },
  };
  const scheduler = new SignedMintScheduler({} as never, { run: async () => ({ status: 'aborted' }) }, repository, flags, index, silentLogger, {}, queue as never);
  return { scheduler, repository, queued };
}

describe('scheduling a signed mint', () => {
  it('a run that cannot be recorded queues nothing: the error is safe to retry', async () => {
    const { scheduler, repository, queued } = rig();
    repository.upsertRun = async () => {
      throw new Error('database down');
    };

    await expect(scheduler.schedule(data)).rejects.toThrow('database down');

    expect(queued).toEqual([]);
  });

  it('a job that cannot be queued does not leave a run that looks scheduled', async () => {
    const { scheduler, repository } = rig({ addFails: true });

    await expect(scheduler.schedule(data)).rejects.toThrow('redis down');

    expect([...repository.runs.values()].map((r) => r.status)).toEqual(['cancelled']);
  });

  it('records the run and queues exactly one job', async () => {
    const { scheduler, repository, queued } = rig();

    const jobId = await scheduler.schedule(data);

    expect(queued).toEqual([jobId]);
    expect(repository.runs.get(jobId)?.status).toBe('scheduled');
  });
});

describe('a signed-mint run that stopped without finishing (its worker crashed, or it threw)', () => {
  const wallet = (walletId: string) => ({ jobId: 'job-x', ownerId: 'owner-1', walletId, walletAddress: `0x${walletId.padEnd(40, '0')}`, quantity: 1 });

  async function interrupted() {
    const { scheduler, repository } = rig();
    await repository.upsertRun({ jobId: 'job-x', ownerId: 'owner-1', chainId: 4663, contract: data.nftContract, slug: 'kid-story', stageUuid: 'stage-1', stageLabel: 'FCFS', t0: new Date(), dryRun: false, simulate: true, rehearsal: false, status: 'fetching' });
    await repository.upsertAttempt(wallet('a1'), { status: 'broadcast', txHash: `0x${'ab'.repeat(32)}`, nonce: 4 });
    await repository.upsertAttempt(wallet('b2'), { status: 'pending' });
    return { scheduler, repository };
  }

  it('is closed: the wallet with no outcome says so, and the one that was sent keeps its hash', async () => {
    const { scheduler, repository } = await interrupted();

    await scheduler.finalizeInterrupted('job-x');

    const run = repository.runs.get('job-x')!;
    expect(run.status).toBe('finished');
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.notes).toMatch(/interrupted/);
    expect(repository.attempts.get('job-x:a1')).toMatchObject({ status: 'broadcast', txHash: `0x${'ab'.repeat(32)}` });
    expect(repository.attempts.get('job-x:b2')).toMatchObject({ status: 'failed', reason: 'interrupted' });
  });

  it('a run that finished on its own is left exactly as it was', async () => {
    const { scheduler, repository } = await interrupted();
    const finishedAt = new Date(Date.now() - 60_000);
    await repository.updateRun('job-x', { status: 'aborted', finishedAt });

    await scheduler.finalizeInterrupted('job-x');

    expect(repository.runs.get('job-x')).toMatchObject({ status: 'aborted', finishedAt });
    expect(repository.attempts.get('job-x:b2')!.status).toBe('pending');
  });
});

describe('the start-time re-check', () => {
  const moved = async () => ({ ok: true as const, timing: { startMs: data.startMs + 30_000 } });

  it('a job that cannot be moved keeps its stored start: the delay is changed first', async () => {
    const job = {
      id: 'j1',
      data: { ...data },
      updates: 0,
      async changeDelay() {
        throw new Error('Job is not in the delayed state');
      },
      async updateData(d: SignedMintJobData) {
        this.updates++;
        this.data = d;
      },
    };
    const queue = { getJobs: async () => [job] };
    const scheduler = new SignedMintScheduler({} as never, { run: async () => ({ status: 'aborted' }) }, new InMemorySignedMintRepository(), flags, index, silentLogger, { resolveStage: moved as never }, queue as never);

    expect(await scheduler.recheckOnce()).toEqual([]);
    expect(job.updates).toBe(0);
    expect(job.data.startMs).toBe(data.startMs);
  });

  it('never runs two passes at once, however slow one is', async () => {
    let passes = 0;
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    const queue = {
      getJobs: async () => {
        passes++;
        await slow;
        return [];
      },
    };
    const scheduler = new SignedMintScheduler({} as never, { run: async () => ({ status: 'aborted' }) }, new InMemorySignedMintRepository(), flags, index, silentLogger, { resolveStage: moved as never }, queue as never);

    scheduler.startRecheck(5);
    await new Promise((r) => setTimeout(r, 40));
    expect(passes).toBe(1);
    finish();
    await scheduler.close().catch(() => undefined);
  });
});
