import { describe, expect, it } from 'vitest';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { InMemorySignedMintRepository } from '../src/signed-mint-repository.js';
import type { SignedMintJobData } from '../src/signed-mint-runner.js';
import type { SignedStageResolution } from '../src/signed-mint-start-resolver.js';
import type { SignedMintScheduler } from '../src/signed-mint-scheduler.js';

const TOKEN = 'test-secret-token-12345';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = 1_790_000_000_000;
const START = NOW + 3_600_000;

function okStage(over: Partial<{ startMs: number; endMs: number | null; maxPerWallet: number | null }> = {}): SignedStageResolution {
  return {
    ok: true,
    snapshot: { stages: [], serverDateMs: null, localMidpointMs: NOW, roundTripMs: 10 },
    timing: {
      stageUuid: 'stage-1',
      label: 'FCFS',
      startMs: over.startMs ?? START,
      endMs: over.endMs ?? null,
      priceWei: '0',
      maxPerWallet: over.maxPerWallet === undefined ? 2 : over.maxPerWallet,
      onChainWindow: { minStartTime: 0, maxEndTime: 2_000_000_000, signerCount: 1 },
    },
  };
}

function setup(opts: { enabled?: boolean; stage?: SignedStageResolution; wallets?: string[] } = {}) {
  const scheduled: SignedMintJobData[] = [];
  const cancelled: string[] = [];
  const repository = new InMemorySignedMintRepository();
  const known = new Set(opts.wallets ?? ['w1', 'w2']);
  const scheduler = {
    schedule: async (data: SignedMintJobData) => {
      scheduled.push(data);
      return 'signed-abc';
    },
    list: async () => [],
    cancel: async (jobId: string) => {
      cancelled.push(jobId);
      return jobId === 'signed-abc' ? 'cancelled' : 'not_found';
    },
  } as unknown as SignedMintScheduler;
  const app = buildApp({
    walletService: {
      getWalletSummary: async (_o: string, id: string) => {
        if (!known.has(id)) throw new Error('not found');
        return { id, address: '0x0000000000000000000000000000000000000001', status: 'ACTIVE' };
      },
    } as never,
    logger: noopLogger,
    authToken: TOKEN,
    signedMint: {
      scheduler,
      repository,
      walletService: {
        getWalletSummary: async (_o: string, id: string) => {
          if (!known.has(id)) throw new Error('not found');
          return { id } as never;
        },
      },
      resolveStage: async () => opts.stage ?? okStage(),
      executionEnabled: opts.enabled ?? true,
      retryIntervalMs: 250,
      giveUpMs: 60_000,
      now: () => NOW,
    },
  });
  return { app, scheduled, cancelled, repository };
}

const body = (over: Record<string, unknown> = {}) => ({
  chainId: 4663,
  nftContract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768',
  slug: 'kid-story',
  stageUuid: 'stage-1',
  wallets: [
    { walletId: 'w1', quantity: 2 },
    { walletId: 'w2', quantity: 1 },
  ],
  maxPriceWei: '0',
  ...over,
});

describe('/signed-mints', () => {
  it('reports the kill switch state', async () => {
    const { app } = setup({ enabled: false });
    const res = await app.inject({ method: 'GET', url: '/signed-mints/status', headers: AUTH });
    expect(res.json()).toEqual({ executionEnabled: false, retryIntervalMs: 250, giveUpMs: 60_000 });
  });

  it('refuses to schedule anything while the kill switch is off', async () => {
    const { app, scheduled } = setup({ enabled: false });
    const res = await app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('signed_mint_disabled');
    expect(scheduled).toHaveLength(0);
  });

  it('schedules for the stage start OpenSea reports, with per-wallet quantities and the defaults (simulate on, real run)', async () => {
    const { app, scheduled } = setup();
    const res = await app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body() });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ jobId: 'signed-abc', startAt: new Date(START).toISOString(), stageLabel: 'FCFS', rehearsal: false });
    expect(scheduled[0]).toMatchObject({
      ownerId: RESERVED_OPERATOR_USER_ID,
      startMs: START,
      stageLabel: 'FCFS',
      wallets: [
        { walletId: 'w1', quantity: 2 },
        { walletId: 'w2', quantity: 1 },
      ],
      settings: { simulate: true, dryRun: false, maxSpendWei: null, retryIntervalMs: 250, giveUpMs: 60_000 },
      rehearsal: false,
    });
  });

  it('a rehearsal time is accepted for a dry run only, and replaces the stage start', async () => {
    const { app, scheduled } = setup();
    const at = NOW + 120_000;
    const refused = await app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body({ rehearsalStartAt: at }) });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('rehearsal_requires_dry_run');

    const ok = await app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body({ rehearsalStartAt: at, dryRun: true }) });
    expect(ok.statusCode).toBe(201);
    expect(scheduled[0]).toMatchObject({ startMs: at, rehearsal: true, settings: { dryRun: true } });
  });

  it('404s a wallet the caller does not own', async () => {
    const { app } = setup({ wallets: ['w1'] });
    const res = await app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'wallet_not_found', walletId: 'w2' });
  });

  it.each([
    ['outside_onchain_bounds', 409],
    ['opensea_unavailable', 503],
  ] as const)('passes a stage resolution failure through: %s -> %i', async (reason, status) => {
    const { app } = setup({ stage: { ok: false, reason, detail: 'x' } });
    const res = await app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body() });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: 'cannot_schedule_signed_mint', reason });
  });

  it('refuses a quantity over the stage per-wallet limit, and a stage too close to start', async () => {
    const over = await setup({ stage: okStage({ maxPerWallet: 1 }) }).app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body() });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe('quantity_over_stage_limit');

    const soon = await setup({ stage: okStage({ startMs: NOW + 5_000 }) }).app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body() });
    expect(soon.statusCode).toBe(409);
    expect(soon.json().error).toBe('too_close_to_start');
  });

  it('rejects a duplicated wallet in one job', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/signed-mints',
      headers: AUTH,
      payload: body({ wallets: [{ walletId: 'w1', quantity: 1 }, { walletId: 'w1', quantity: 1 }] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('cancel: 404 for an unknown job, 200 with the result otherwise', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'DELETE', url: '/signed-mints/nope', headers: AUTH })).statusCode).toBe(404);
    const res = await app.inject({ method: 'DELETE', url: '/signed-mints/signed-abc', headers: AUTH });
    expect(res.json()).toEqual({ jobId: 'signed-abc', result: 'cancelled' });
  });

  it('report: the run and every wallet row for its owner, 404 for anyone else', async () => {
    const { app, repository } = setup();
    const run = {
      jobId: 'signed-abc',
      ownerId: RESERVED_OPERATOR_USER_ID,
      chainId: 4663,
      contract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768',
      slug: 'kid-story',
      stageUuid: 'stage-1',
      stageLabel: 'FCFS',
      t0: new Date(START),
      dryRun: false,
      simulate: true,
      rehearsal: false,
      status: 'finished',
    };
    await repository.upsertRun(run);
    await repository.upsertAttempt({ jobId: 'signed-abc', ownerId: RESERVED_OPERATOR_USER_ID, walletId: 'w1', walletAddress: '0x1', quantity: 2 }, { status: 'confirmed', calldataMs: 12, broadcastMs: 40 });

    const res = await app.inject({ method: 'GET', url: '/signed-mints/signed-abc/report', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().attempts[0]).toMatchObject({ walletId: 'w1', status: 'confirmed', calldataMs: 12, broadcastMs: 40 });

    await repository.upsertRun({ ...run, jobId: 'signed-other', ownerId: 'someone-else' });
    expect((await app.inject({ method: 'GET', url: '/signed-mints/signed-other/report', headers: AUTH })).statusCode).toBe(404);
  });

  it('"mint now" on a live stage fires straight away: T-0 is 2s out, marked immediate, real or dry run', async () => {
    const live = setup({ stage: okStage({ startMs: NOW - 600_000, endMs: NOW + 3_600_000 }) });
    const res = await live.app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body({ fireNow: true }) });
    expect(res.statusCode).toBe(201);
    expect(live.scheduled[0]).toMatchObject({ startMs: NOW + 2_000, immediate: true, rehearsal: false, settings: { dryRun: false } });
  });

  it('"mint now" refuses a stage that has not started or has ended, and cannot be combined with a rehearsal time', async () => {
    const early = await setup().app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body({ fireNow: true }) });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe('stage_not_live');

    const ended = await setup({ stage: okStage({ startMs: NOW - 7_200_000, endMs: NOW - 60_000 }) }).app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body({ fireNow: true }) });
    expect(ended.statusCode).toBe(409);
    expect(ended.json().error).toBe('stage_ended');

    const both = await setup().app.inject({ method: 'POST', url: '/signed-mints', headers: AUTH, payload: body({ fireNow: true, dryRun: true, rehearsalStartAt: NOW + 60_000 }) });
    expect(both.statusCode).toBe(400);
  });
});
