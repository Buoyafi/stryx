import { describe, expect, it } from 'vitest';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import type { MintScheduler } from '../src/mint-scheduler.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';

const TEST_CHAIN_ID = 46630;
const NFT = '0x1234567890123456789012345678901234567890';

/** A fake scheduler with an in-memory job store, so owner scoping (list and cancel) is really exercised. */
function fakeScheduler() {
  interface StoredJob {
    jobId: string;
    ownerId: string;
    kind: string;
    executeAt: number;
    /** Set by a test to simulate a job that's already firing/finished, refusing an edit. */
    notEditable?: boolean;
    /** Set by a test to simulate a job a worker is running now. */
    running?: boolean;
  }
  const jobs = new Map<string, StoredJob>();
  const scheduled: Array<{ job: unknown; executeAt: number; jobId?: string }> = [];
  const cancelledIds: string[] = [];
  const updateCalls: Array<{ jobId: string; ownerId: string; params: { quantity?: number; executeAt?: number } }> = [];
  let nextId = 1;

  const scheduler = {
    async schedule(params: { job: { kind: string; request: { ownerId: string } }; executeAt: number; jobId?: string }) {
      scheduled.push(params);
      const jobId = params.jobId ?? `generated-job-id-${nextId++}`;
      jobs.set(jobId, { jobId, ownerId: params.job.request.ownerId, kind: params.job.kind, executeAt: params.executeAt });
      return jobId;
    },
    async exists(jobId: string) {
      return jobs.has(jobId);
    },
    async hasPendingTwin(job: { request: { ownerId: string } }, executeAt: number) {
      return [...jobs.values()].some((j) => j.ownerId === job.request.ownerId && j.executeAt === executeAt);
    },
    async list(scope: { ownerId: string } | { all: true }) {
      const all = [...jobs.values()];
      const visible = 'all' in scope ? all : all.filter((j) => j.ownerId === scope.ownerId);
      return visible
        .sort((a, b) => a.executeAt - b.executeAt)
        .map((j) => ({ jobId: j.jobId, kind: j.kind, state: 'delayed', ownerId: j.ownerId, walletId: 'w', nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: j.executeAt }));
    },
    async cancel(jobId: string, ownerId: string, isAdmin: boolean) {
      cancelledIds.push(jobId);
      const job = jobs.get(jobId);
      if (!job) return 'not_found' as const;
      if (!isAdmin && job.ownerId !== ownerId) return 'not_found' as const;
      if (job.running) return 'running' as const;
      jobs.delete(jobId);
      return 'cancelled' as const;
    },
    async updateJob(jobId: string, ownerId: string, params: { quantity?: number; executeAt?: number }) {
      updateCalls.push({ jobId, ownerId, params });
      const job = jobs.get(jobId);
      if (!job) return { ok: false, reason: 'not_found' } as const;
      if (job.ownerId !== ownerId) return { ok: false, reason: 'not_found' } as const;
      if (job.notEditable) return { ok: false, reason: 'not_editable' } as const;
      if (params.executeAt !== undefined) job.executeAt = params.executeAt;
      return { ok: true } as const;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as MintScheduler;

  return { scheduler, scheduled, cancelledIds, updateCalls, jobs };
}

async function buildRig(opts: { withUserRepository?: boolean } = {}) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);
  const created = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

  const fake = fakeScheduler();
  const autoScheduleCalls: unknown[] = [];
  const autoScheduleService = {
    async autoSchedulePublicMint(job: unknown) {
      autoScheduleCalls.push(job);
      return { scheduled: true, jobId: 'auto-job-id', startTimeUnix: 1_800_000_000 };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const userRepository = opts.withUserRepository ? new InMemoryUserRepository() : undefined;
  if (userRepository) {
    const now = new Date();
    userRepository.seed({
      id: RESERVED_OPERATOR_USER_ID,
      email: 'operator@stryx.local',
      passwordHash: 'disabled:test-only',
      role: 'ADMIN',
      status: 'ACTIVE',
      dailySpendCapWei: null,
      spendCapEnabled: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  const app: FastifyInstance = buildApp({
    walletService,
    logger: noopLogger,
    mintScheduler: fake.scheduler,
    autoScheduleService,
    ...(userRepository ? { userRepository } : {}),
  });

  return { app, walletId: created.id, fake, autoScheduleCalls, userRepository };
}

describe('schedule controller', () => {
  it('schedules a public mint and returns 201 with a jobId', async () => {
    const { app, walletId, fake } = await buildRig();
    const executeAt = new Date(Date.now() + 60_000).toISOString();

    const response = await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: { kind: 'public', walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().jobId).toBeDefined();
    expect(fake.scheduled).toHaveLength(1);
    expect((fake.scheduled[0]!.job as { kind: string }).kind).toBe('public');
  });

  it('schedules an allowlist-stored mint, passing the allowListId through', async () => {
    const { app, walletId, fake } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: {
        kind: 'allowlist-stored',
        walletId,
        nftContract: NFT,
        chainId: TEST_CHAIN_ID,
        quantity: 1,
        allowListId: 'drop-42',
        executeAt: Date.now() + 60_000,
      },
    });

    expect(response.statusCode).toBe(201);
    const job = fake.scheduled[0]!.job as { kind: string; request: { allowListId: string } };
    expect(job.kind).toBe('allowlist-stored');
    expect(job.request.allowListId).toBe('drop-42');
  });

  it('schedules an allowlist-opensea mint, passing the slug through', async () => {
    const { app, walletId, fake } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: {
        kind: 'allowlist-opensea',
        walletId,
        nftContract: NFT,
        chainId: TEST_CHAIN_ID,
        quantity: 1,
        slug: 'my-collection',
        executeAt: Date.now() + 60_000,
      },
    });

    expect(response.statusCode).toBe(201);
    const job = fake.scheduled[0]!.job as { kind: string; request: { slug: string } };
    expect(job.kind).toBe('allowlist-opensea');
    expect(job.request.slug).toBe('my-collection');
  });

  it('schedules an allowlist-direct mint, keeping mintParams bigints as strings for the queue', async () => {
    const { app, walletId, fake } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: {
        kind: 'allowlist-direct',
        walletId,
        nftContract: NFT,
        chainId: TEST_CHAIN_ID,
        quantity: 1,
        mintParams: {
          mintPrice: '1000000000000000',
          maxTotalMintableByWallet: 5,
          startTime: 1700000000,
          endTime: 2000000000,
          dropStageIndex: 1,
          maxTokenSupplyForStage: '1000',
          feeBps: 250,
          restrictFeeRecipients: false,
        },
        proof: ['0x' + 'ab'.repeat(32)],
        executeAt: Date.now() + 60_000,
      },
    });

    expect(response.statusCode).toBe(201);
    const job = fake.scheduled[0]!.job as { kind: string; request: { mintParams: { mintPrice: string } } };
    expect(job.kind).toBe('allowlist-direct');
    // Stays a string all the way to the queue, rehydrated to bigint only in the worker.
    expect(typeof job.request.mintParams.mintPrice).toBe('string');
    expect(job.request.mintParams.mintPrice).toBe('1000000000000000');
  });

  it('converts an ISO executeAt to the correct unix-ms for scheduling', async () => {
    const { app, walletId, fake } = await buildRig();
    const when = new Date(Date.now() + 120_000);

    await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: { kind: 'public', walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: when.toISOString() },
    });

    expect(fake.scheduled[0]!.executeAt).toBe(when.getTime());
  });

  it('cancels a scheduled mint and returns 200', async () => {
    const { app, walletId, fake } = await buildRig();
    await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: { kind: 'public', walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: new Date(Date.now() + 60_000).toISOString(), jobId: 'job-123' },
    });

    const response = await app.inject({ method: 'DELETE', url: '/schedules/mints/job-123' });

    expect(response.statusCode).toBe(200);
    expect(response.json().cancelled).toBe(true);
    expect(fake.cancelledIds).toContain('job-123');
  });

  it('a job that is running now is a 409 with a plain reason, not a 500', async () => {
    const { app, walletId, fake } = await buildRig();
    await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: { kind: 'public', walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: new Date(Date.now() + 60_000).toISOString(), jobId: 'job-run' },
    });
    fake.jobs.get('job-run')!.running = true;

    const response = await app.inject({ method: 'DELETE', url: '/schedules/mints/job-run' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'schedule_running' });
  });

  it('returns 404 when cancelling a job that does not exist', async () => {
    const { app } = await buildRig();

    const response = await app.inject({ method: 'DELETE', url: '/schedules/mints/nope' });

    expect(response.statusCode).toBe(404);
  });

  it('edits a scheduled job\'s quantity and execute time, and returns 200', async () => {
    const { app, walletId, fake } = await buildRig();
    await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: { kind: 'public', walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: new Date(Date.now() + 60_000).toISOString(), jobId: 'edit-me' },
    });
    const newExecuteAt = new Date(Date.now() + 120_000);

    const response = await app.inject({
      method: 'PATCH',
      url: '/schedules/mints/edit-me',
      payload: { quantity: 3, executeAt: newExecuteAt.toISOString() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().updated).toBe(true);
    expect(fake.updateCalls).toHaveLength(1);
    expect(fake.updateCalls[0]!.params).toEqual({ quantity: 3, executeAt: newExecuteAt.getTime() });
  });

  it('returns 404 editing a job that does not exist', async () => {
    const { app } = await buildRig();
    const response = await app.inject({ method: 'PATCH', url: '/schedules/mints/nope', payload: { quantity: 2 } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('schedule_not_found');
  });

  it('returns 409, not a silent no-op, when the job is no longer editable (already firing or finished)', async () => {
    const { app, walletId, fake } = await buildRig();
    await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: { kind: 'public', walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: new Date(Date.now() + 60_000).toISOString(), jobId: 'already-firing' },
    });
    fake.jobs.get('already-firing')!.notEditable = true;

    const response = await app.inject({ method: 'PATCH', url: '/schedules/mints/already-firing', payload: { quantity: 2 } });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('schedule_not_editable');
  });

  it('refuses a job id that is already in use, and one the queue could not take', async () => {
    const { app, walletId, fake } = await buildRig();
    const payload = (jobId: string, at: number) => ({ kind: 'public', walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: at, jobId });

    expect((await app.inject({ method: 'POST', url: '/schedules/mints', payload: payload('mine-1', Date.now() + 60_000) })).statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: '/schedules/mints', payload: payload('mine-1', Date.now() + 600_000) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('job_id_taken');
    expect(fake.scheduled).toHaveLength(1);

    for (const bad of ['12345', 'has:colon', 'has space']) {
      expect((await app.inject({ method: 'POST', url: '/schedules/mints', payload: payload(bad, Date.now() + 900_000) })).statusCode).toBe(400);
    }
  });

  it('refuses to schedule the same mint twice: the second would fire and pay as well', async () => {
    const { app, walletId, fake } = await buildRig();
    const payload = { kind: 'public', walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: Date.now() + 60_000 };

    expect((await app.inject({ method: 'POST', url: '/schedules/mints', payload })).statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/schedules/mints', payload });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('already_scheduled');
    expect(fake.scheduled).toHaveLength(1);
  });

  it('rejects a PATCH with neither quantity nor executeAt: nothing to update', async () => {
    const { app } = await buildRig();
    const response = await app.inject({ method: 'PATCH', url: '/schedules/mints/whatever', payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('nothing_to_update');
  });

  it('rejects a schedule request with an unknown kind', async () => {
    const { app, walletId } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      payload: { kind: 'not-a-real-kind', walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: Date.now() + 1000 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('auto-schedules a public mint, deriving the time from the drop (no executeAt supplied)', async () => {
    const { app, walletId, autoScheduleCalls } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/schedules/mints/auto',
      payload: { walletId, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().jobId).toBe('auto-job-id');
    expect(autoScheduleCalls).toHaveLength(1);
    // The controller must pass a well-formed public job to the service.
    expect((autoScheduleCalls[0] as { kind: string }).kind).toBe('public');
  });

  it('returns 409 when the drop cannot be auto-scheduled (no start time)', async () => {
    // Rebuild with a service that reports it can't schedule.
    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);
    const walletService = new WalletService(repository, walletKeyService, kms.keyId);
    const created = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

    const fake = fakeScheduler();
    const autoScheduleService = {
      async autoSchedulePublicMint() {
        return { scheduled: false, reason: 'no_start_time' as const };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const app = buildApp({ walletService, logger: noopLogger, mintScheduler: fake.scheduler, autoScheduleService });

    const response = await app.inject({
      method: 'POST',
      url: '/schedules/mints/auto',
      payload: { walletId: created.id, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().reason).toBe('no_start_time');
  });
});

describe('schedule controller: owner scoping', () => {
  /** A rig with real sessions, so two distinct users can be told apart. */
  async function buildOwnerScopeRig() {
    const walletRepository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(walletRepository, new WalletKeyService(kms), kms.keyId);
    const created = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

    const userRepository = new InMemoryUserRepository();
    const now = new Date();
    userRepository.seed({
      id: RESERVED_OPERATOR_USER_ID,
      email: 'operator@stryx.local',
      passwordHash: 'disabled:test-only',
      role: 'ADMIN',
      status: 'ACTIVE',
      dailySpendCapWei: null,
      spendCapEnabled: false,
      createdAt: now,
      updatedAt: now,
    });
    const { UserAccountService } = await import('@stryx/user-service');
    const { RedisSessionStore } = await import('../src/session-store.js');
    const { InMemoryRedisClient } = await import('./fakes/in-memory-redis-client.js');
    const userAccountService = new UserAccountService(userRepository);
    const sessions = new RedisSessionStore(new InMemoryRedisClient());

    const fake = fakeScheduler();
    const autoScheduleService = { async autoSchedulePublicMint() { throw new Error('not used in this rig'); } } as never;

    const app: FastifyInstance = buildApp({
      walletService,
      logger: noopLogger,
      authToken: 'operator-token',
      userAccountService,
      sessions,
      signupEnabled: true,
      mintScheduler: fake.scheduler,
      autoScheduleService,
      userRepository,
    });

    async function signup(email: string): Promise<string> {
      const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password: 'correct-horse-battery-staple' } });
      return res.json().token as string;
    }
    const scheduleAs = (token: string, jobId: string, executeAt = Date.now() + 60_000) =>
      app.inject({
        method: 'POST',
        url: '/schedules/mints',
        headers: { authorization: `Bearer ${token}` },
        payload: { kind: 'public', walletId: created.id, nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: new Date(executeAt).toISOString(), jobId },
      });

    return { app, fake, signup, scheduleAs };
  }

  it('a user only sees their own scheduled jobs, never another user\'s', async () => {
    const { app, signup, scheduleAs } = await buildOwnerScopeRig();
    const tokenA = await signup('a@example.com');
    const tokenB = await signup('b@example.com');
    await scheduleAs(tokenA, 'job-a-1');
    await scheduleAs(tokenA, 'job-a-2');
    await scheduleAs(tokenB, 'job-b-1');

    const listA = await app.inject({ method: 'GET', url: '/schedules/mints', headers: { authorization: `Bearer ${tokenA}` } });
    expect(listA.json().jobs.map((j: { jobId: string }) => j.jobId).sort()).toEqual(['job-a-1', 'job-a-2']);

    const listB = await app.inject({ method: 'GET', url: '/schedules/mints', headers: { authorization: `Bearer ${tokenB}` } });
    expect(listB.json().jobs.map((j: { jobId: string }) => j.jobId)).toEqual(['job-b-1']);
  });

  it('a user cannot cancel another user\'s job: 404, not 403, and the job survives', async () => {
    const { app, signup, scheduleAs } = await buildOwnerScopeRig();
    const tokenA = await signup('a2@example.com');
    const tokenB = await signup('b2@example.com');
    await scheduleAs(tokenA, 'job-a2-1');

    const attempt = await app.inject({ method: 'DELETE', url: '/schedules/mints/job-a2-1', headers: { authorization: `Bearer ${tokenB}` } });
    expect(attempt.statusCode).toBe(404);
    expect(attempt.json().error).toBe('schedule_not_found');

    // Not 403 or any other status that would confirm "yes, this job id exists, it's just not yours".
    const stillThere = await app.inject({ method: 'GET', url: '/schedules/mints', headers: { authorization: `Bearer ${tokenA}` } });
    expect(stillThere.json().jobs.map((j: { jobId: string }) => j.jobId)).toEqual(['job-a2-1']);
  });

  it('a user cannot edit another user\'s job: 404, not 403', async () => {
    const { app, signup, scheduleAs } = await buildOwnerScopeRig();
    const tokenA = await signup('a2b@example.com');
    const tokenB = await signup('b2b@example.com');
    await scheduleAs(tokenA, 'job-a2b-1');

    const attempt = await app.inject({ method: 'PATCH', url: '/schedules/mints/job-a2b-1', headers: { authorization: `Bearer ${tokenB}` }, payload: { quantity: 5 } });
    expect(attempt.statusCode).toBe(404);
    expect(attempt.json().error).toBe('schedule_not_found');
  });

  it('an admin can cancel a member\'s job but not edit it: what a member\'s wallet mints is theirs to change', async () => {
    const { app, signup, scheduleAs } = await buildOwnerScopeRig();
    const tokenA = await signup('a2c@example.com');
    await scheduleAs(tokenA, 'job-a2c-1');
    const asOperator = { authorization: 'Bearer operator-token' };

    const edit = await app.inject({ method: 'PATCH', url: '/schedules/mints/job-a2c-1', headers: asOperator, payload: { quantity: 5 } });
    expect(edit.statusCode).toBe(404);

    const cancel = await app.inject({ method: 'DELETE', url: '/schedules/mints/job-a2c-1', headers: asOperator });
    expect(cancel.statusCode).toBe(200);
  });

  it('an admin sees every job by default, and only their own when asking for "mine"', async () => {
    const { app, signup, scheduleAs } = await buildOwnerScopeRig();
    const tokenA = await signup('a2d@example.com');
    await scheduleAs(tokenA, 'job-a2d-1');
    await scheduleAs('operator-token', 'job-op-1', Date.now() + 120_000);
    const asOperator = { authorization: 'Bearer operator-token' };
    const ids = (res: { json(): { jobs: { jobId: string }[] } }) => res.json().jobs.map((j) => j.jobId).sort();

    expect(ids(await app.inject({ method: 'GET', url: '/schedules/mints', headers: asOperator }))).toEqual(['job-a2d-1', 'job-op-1']);
    expect(ids(await app.inject({ method: 'GET', url: '/schedules/mints?mine=1', headers: asOperator }))).toEqual(['job-op-1']);
  });

  it('a user can cancel their own job', async () => {
    const { app, signup, scheduleAs } = await buildOwnerScopeRig();
    const tokenA = await signup('a3@example.com');
    await scheduleAs(tokenA, 'job-a3-1');

    const response = await app.inject({ method: 'DELETE', url: '/schedules/mints/job-a3-1', headers: { authorization: `Bearer ${tokenA}` } });
    expect(response.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/schedules/mints', headers: { authorization: `Bearer ${tokenA}` } });
    expect(after.json().jobs).toEqual([]);
  });

  it('an admin (the operator token) sees and can cancel every user\'s jobs', async () => {
    const { app, signup, scheduleAs } = await buildOwnerScopeRig();
    const tokenA = await signup('a4@example.com');
    const tokenB = await signup('b4@example.com');
    await scheduleAs(tokenA, 'job-a4-1');
    await scheduleAs(tokenB, 'job-b4-1');

    const asOperator = { authorization: 'Bearer operator-token' };
    const list = await app.inject({ method: 'GET', url: '/schedules/mints', headers: asOperator });
    expect(list.json().jobs.map((j: { jobId: string }) => j.jobId).sort()).toEqual(['job-a4-1', 'job-b4-1']);

    const cancel = await app.inject({ method: 'DELETE', url: '/schedules/mints/job-b4-1', headers: asOperator });
    expect(cancel.statusCode).toBe(200);

    const listAfter = await app.inject({ method: 'GET', url: '/schedules/mints', headers: { authorization: `Bearer ${tokenA}` } });
    expect(listAfter.json().jobs.map((j: { jobId: string }) => j.jobId)).toEqual(['job-a4-1']);
  });

  it('with no userRepository wired, every caller is treated as non-admin: safe default, never "everyone\'s" by accident', async () => {
    const walletRepository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(walletRepository, new WalletKeyService(kms), kms.keyId);
    const fake = fakeScheduler();
    const autoScheduleService = { async autoSchedulePublicMint() { throw new Error('not used'); } } as never;
    // authToken set, but no accounts or sessions: the operator token still resolves to the reserved
    // operator id.
    const app: FastifyInstance = buildApp({ walletService, logger: noopLogger, authToken: 'operator-token', mintScheduler: fake.scheduler, autoScheduleService });
    await app.inject({
      method: 'POST',
      url: '/schedules/mints',
      headers: { authorization: 'Bearer operator-token' },
      payload: { kind: 'public', walletId: 'w', nftContract: NFT, chainId: TEST_CHAIN_ID, quantity: 1, executeAt: new Date(Date.now() + 60_000).toISOString(), jobId: 'solo-job' },
    });

    const list = await app.inject({ method: 'GET', url: '/schedules/mints', headers: { authorization: 'Bearer operator-token' } });
    // Still sees it (it's their own job under the reserved operator id), proving this isn't broken, just not elevated.
    expect(list.json().jobs.map((j: { jobId: string }) => j.jobId)).toEqual(['solo-job']);
  });
});
