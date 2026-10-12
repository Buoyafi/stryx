import { describe, expect, it } from 'vitest';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { UserAccountService } from '@stryx/user-service';
import { noopLogger } from '@stryx/logger';
import { InProcessEventBus } from '@stryx/event-bus';
import { buildApp } from '../src/app.js';
import type { OperatorTokenMode } from '../src/auth.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { RedisSessionStore } from '../src/session-store.js';
import { RedisRateLimiter } from '../src/rate-limiter.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { StepUpStore } from '../src/step-up-store.js';
import { chainSummaries, failureClass, mintTotals, seriesBuckets, timeSeries, type PlatformStatsRepository } from '../src/platform-stats.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';

describe('what the numbers mean', () => {
  it('a mint is a settled attempt; success and platform health rates; pending apart', () => {
    const t = mintTotals([
      { status: 'CONFIRMED', failureReason: null, count: 6 },
      { status: 'REVERTED', failureReason: null, count: 1 },
      { status: 'DROPPED', failureReason: null, count: 1 },
      { status: 'BLOCKED', failureReason: 'not_eligible', count: 3 },
      { status: 'BLOCKED', failureReason: 'emergency_stop', count: 1 },
      { status: 'BLOCKED', failureReason: 'rpc_unavailable', count: 2 },
      { status: 'BLOCKED', failureReason: 'something_new', count: 1 },
      { status: 'PENDING', failureReason: null, count: 2 },
      { status: 'SENDING', failureReason: null, count: 1 },
    ]);
    expect(t).toMatchObject({ settled: 15, confirmed: 6, reverted: 1, dropped: 1, blocked: 7, pending: 3 });
    expect(t.successRate).toBeCloseTo(6 / 15);
    expect(t.healthRate).toBeCloseTo(6 / (15 - 3 - 1)); // USER (3) and POLICY (1) left out
    expect(t.failures).toEqual({ USER: 3, POLICY: 1, INFRA: 2, CHAIN: 2, OTHER: 1 });
    expect(t.topReasons[0]).toEqual({ reason: 'not_eligible', failureClass: 'USER', count: 3 });
  });

  it('with nothing settled there is no rate, never 0%', () => {
    expect(mintTotals([{ status: 'PENDING', failureReason: null, count: 4 }])).toMatchObject({ settled: 0, successRate: null, healthRate: null, pending: 4 });
    expect(mintTotals([])).toMatchObject({ successRate: null });
  });

  it('classes failures: on-chain reverts and drops are CHAIN, unknown reasons are OTHER, successes none', () => {
    expect(failureClass('REVERTED', null)).toBe('CHAIN');
    expect(failureClass('DROPPED', null)).toBe('CHAIN');
    expect(failureClass('BLOCKED', 'simulation_reverted')).toBe('CHAIN');
    expect(failureClass('BLOCKED', 'wrong_minter')).toBe('POLICY');
    expect(failureClass('BLOCKED', 'interrupted')).toBe('INFRA');
    expect(failureClass('BLOCKED', 'insufficient_funds')).toBe('USER');
    expect(failureClass('BLOCKED', null)).toBe('OTHER');
    expect(failureClass('CONFIRMED', null)).toBeNull();
  });

  it('gas is summed per chain in its own token, exactly, with what reverts burned apart', () => {
    const big = (10n ** 30n).toString();
    const chains = chainSummaries([
      { chainId: 1, status: 'CONFIRMED', count: 2, feeWei: big },
      { chainId: 1, status: 'REVERTED', count: 1, feeWei: '5' },
      { chainId: 8453, status: 'BLOCKED', count: 3, feeWei: '0' },
      { chainId: 8453, status: 'PENDING', count: 1, feeWei: '0' },
    ]);
    expect(chains.find((c) => c.chainId === 1)).toMatchObject({ settled: 3, confirmed: 2, failed: 1, feeWei: (10n ** 30n + 5n).toString(), burnedWei: '5' });
    expect(chains.find((c) => c.chainId === 8453)).toMatchObject({ settled: 3, confirmed: 0, pending: 1, successRate: 0 });
  });
});

function fakeStats(): PlatformStatsRepository & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const note = (name: string, arg: unknown) => ((calls[name] ??= []).push(arg), undefined);
  return {
    calls,
    mintStatusCounts: async (since) => (note('since', since), [{ status: 'CONFIRMED', failureReason: null, count: 3 }]),
    mintsByChain: async () => [{ chainId: 1, status: 'CONFIRMED', count: 3, feeWei: '30' }],
    mintsBySource: async () => [{ source: 'MANUAL', count: 3 }],
    mintTimeseries: async (since, unit) => (note('series', { since, unit }), [{ bucket: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000), status: 'CONFIRMED', count: 3 }]),
    topCollections: async () => [{ chainId: 1, contract: '0xabc', mints: 3, confirmed: 3, members: 2 }],
    memberCounts: async () => ({ total: 5, new: 1, active: 2, activated: 3, suspended: 0, admins: 1 }),
    dataStartsAt: async () => new Date('2026-09-30T00:00:00Z'),
    recentMints: async (opts) => (note('recentMints', opts), [{ id: 'm1', ownerId: 'u1', ownerName: 'Ade', walletAddress: '0x1', chainId: 1, contract: '0xabc', kind: 'PUBLIC', quantity: 1, source: 'MANUAL', status: 'CONFIRMED', failureReason: null, failureNote: null, txHash: '0xh', createdAt: new Date('2026-10-01T10:00:00Z') }]),
    members: async (opts) => (note('members', opts), [{ id: 'u1', displayName: 'Ade', role: 'USER', status: 'ACTIVE', createdAt: new Date('2026-09-30T00:00:00Z'), signInAddresses: ['0xA'], wallets: 2, mints: 3, lastMintAt: null }]),
    memberDetail: async (userId, limit) => (note('memberDetail', { userId, limit }), {
      signInWallets: [{ address: '0xA', addedAt: new Date('2026-09-30T00:00:00Z'), lastUsedAt: null }],
      wallets: [{ id: 'w1', address: '0xW', label: 'Main', tier: 'HOT', status: 'ACTIVE', origin: 'GENERATED', createdAt: new Date('2026-09-30T00:00:00Z') }],
      mintCounts: [{ status: 'CONFIRMED', failureReason: null, count: 2 }, { status: 'BLOCKED', failureReason: 'not_eligible', count: 1 }],
      recentMints: [],
      audit: [],
    }),
    audit: async (opts) => (note('audit', opts), [{ id: 'a1', createdAt: new Date('2026-10-01T09:00:00Z'), action: 'session.login_wallet', actorType: 'USER', actorUserId: 'u1', actorName: 'Ade', targetUserId: null, walletId: null, outcome: 'SUCCESS', detail: null }]),
  };
}

async function build(tokenMode?: OperatorTokenMode) {
  const kms = new LocalKeyManagementProvider();
  const users = new InMemoryUserRepository();
  const at = new Date();
  users.seed({ id: RESERVED_OPERATOR_USER_ID, email: 'op@stryx.local', passwordHash: 'disabled', role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: false, createdAt: at, updatedAt: at });
  users.seed({ id: 'member', email: null, passwordHash: null, role: 'USER', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: true, createdAt: at, updatedAt: at });
  const redis = new InMemoryRedisClient();
  const sessions = new RedisSessionStore(redis);
  const audit = new InMemoryAuditLogRepository();
  const stats = fakeStats();
  const stepUp = new StepUpStore(redis);
  const stops: string[] = [];
  const app = buildApp({
    walletService: new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId),
    logger: noopLogger,
    authToken: 'op-token',
    ...(tokenMode ? { operatorTokenMode: tokenMode } : {}),
    userAccountService: new UserAccountService(users),
    sessions,
    auditLogService: new AuditLogService(audit, new InProcessEventBus(), noopLogger),
    platformStats: stats,
    adminViewLimiter: new RedisRateLimiter(redis),
    stepUpStore: stepUp,
    emergencyStopGuard: {
      triggerUserStop: async (id: string, reason: string) => void stops.push(`stop ${id}: ${reason}`),
      clearUserStop: async (id: string) => void stops.push(`clear ${id}`),
    } as never,
  });
  return { app, stats, audit, users, sessions, stepUp, stops, op: { authorization: 'Bearer op-token' }, member: { authorization: `Bearer ${await sessions.create('member')}` } };
}

const ROUTES = ['/admin/overview', '/admin/activity', '/admin/members', '/admin/audit'];

describe('the chart buckets', () => {
  const asOf = Date.parse('2026-10-01T14:35:00Z');
  it('24 hours: 24 whole UTC hours ending with the current one; 7 and 30 days: whole UTC days ending today', () => {
    const h = seriesBuckets('24h', asOf);
    expect(h.unit).toBe('hour');
    expect(h.starts).toHaveLength(24);
    expect(new Date(h.starts[23]!).toISOString()).toBe('2026-10-01T14:00:00.000Z');
    expect(new Date(h.starts[0]!).toISOString()).toBe('2026-09-30T15:00:00.000Z');
    const d = seriesBuckets('30d', asOf);
    expect(d.starts).toHaveLength(30);
    expect(new Date(d.starts[29]!).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(seriesBuckets('7d', asOf).starts).toHaveLength(7);
  });

  it('puts each status in its bucket; before the first record is unknown, not zero', () => {
    const at = (iso: string) => new Date(iso);
    const s = timeSeries('7d', asOf, [
      { bucket: at('2026-10-01T00:00:00Z'), status: 'CONFIRMED', count: 5 },
      { bucket: at('2026-10-01T00:00:00Z'), status: 'REVERTED', count: 1 },
      { bucket: at('2026-10-01T00:00:00Z'), status: 'DROPPED', count: 1 },
      { bucket: at('2026-10-01T00:00:00Z'), status: 'BLOCKED', count: 2 },
      { bucket: at('2026-10-01T00:00:00Z'), status: 'PENDING', count: 3 },
      { bucket: at('2026-09-30T00:00:00Z'), status: 'CONFIRMED', count: 1 },
      { bucket: at('2020-01-01T00:00:00Z'), status: 'CONFIRMED', count: 99 }, // outside the window: ignored
    ], at('2026-09-30T08:00:00Z'));
    const today = s.buckets[6]!;
    expect(today).toMatchObject({ confirmed: 5, reverted: 2, blocked: 2, failed: 4, pending: 3, recorded: true, partial: false });
    expect(s.buckets[5]).toMatchObject({ confirmed: 1, recorded: true, partial: true });
    expect(s.buckets[4]).toMatchObject({ confirmed: 0, recorded: false });
    expect(timeSeries('24h', asOf, [], null).buckets.every((b) => !b.recorded)).toBe(true);
  });
});

describe('the operator Overview routes', () => {
  it('an admin gets the numbers, with the window it asked for and when the data starts', async () => {
    const w = await build();
    const res = await w.app.inject({ method: 'GET', url: '/admin/overview?window=24h', headers: w.op });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ window: '24h', dataStartsAt: '2026-09-30T00:00:00.000Z', members: { total: 5, admins: 1 }, mints: { settled: 3, successRate: 1 }, chains: [{ chainId: 1, feeWei: '30' }] });
    expect(Date.parse(body.asOf) - Date.parse(body.since)).toBe(86_400_000);
    expect(body.series.unit).toBe('hour');
    expect(body.series.buckets).toHaveLength(24);
    expect(body.series.buckets[23]).toMatchObject({ confirmed: 3 });
    expect(w.stats.calls['series']![0]).toMatchObject({ unit: 'hour' });
    expect((await w.app.inject({ method: 'GET', url: '/admin/overview?window=1y', headers: w.op })).statusCode).toBe(400);
  });

  it('a member, and the token in api mode, are refused on every Overview route', async () => {
    const w = await build('api');
    for (const url of ROUTES) {
      expect((await w.app.inject({ method: 'GET', url, headers: w.member })).statusCode, url).toBe(403);
      expect((await w.app.inject({ method: 'GET', url, headers: w.op })).statusCode, url).toBe(403);
    }
    expect(w.stats.calls['recentMints']).toBeUndefined(); // nothing was read
  });

  it('pages each list with a cursor, and filters the audit log by category', async () => {
    const w = await build();
    const page = await w.app.inject({ method: 'GET', url: '/admin/activity?limit=1', headers: w.op });
    expect(page.json()).toMatchObject({ mints: [{ id: 'm1', ownerName: 'Ade' }], nextBefore: '2026-10-01T10:00:00.000Z_m1' });
    await w.app.inject({ method: 'GET', url: `/admin/activity?limit=1&before=${encodeURIComponent(page.json().nextBefore)}`, headers: w.op });
    expect(w.stats.calls['recentMints']![1]).toEqual({ limit: 1, before: { at: new Date('2026-10-01T10:00:00Z'), id: 'm1' } });
    await w.app.inject({ method: 'GET', url: '/admin/audit?category=admin', headers: w.op });
    expect(w.stats.calls['audit']![0]).toMatchObject({ prefixes: ['admin.', 'access_code.', 'role.', 'operator.', 'spend_cap.', 'waitlist.'] });
    expect((await w.app.inject({ method: 'GET', url: '/admin/audit?category=everything', headers: w.op })).statusCode).toBe(400);
    expect((await w.app.inject({ method: 'GET', url: '/admin/members', headers: w.op })).json().members[0]).toMatchObject({ signInAddresses: ['0xA'], mints: 3 });
  });

  it("reading members' records is audit-logged once per 10 minutes, not once per poll; totals are not", async () => {
    const w = await build();
    for (let i = 0; i < 3; i++) {
      await w.app.inject({ method: 'GET', url: '/admin/activity', headers: w.op });
      await w.app.inject({ method: 'GET', url: '/admin/overview', headers: w.op });
    }
    await w.app.inject({ method: 'GET', url: '/admin/members', headers: w.op });
    const views = w.audit.entries.filter((e) => e.action.startsWith('admin.view'));
    expect(views.map((e) => e.action)).toEqual(['admin.view_activity', 'admin.view_members']);
    expect(views[0]).toMatchObject({ actorUserId: RESERVED_OPERATOR_USER_ID, actorType: 'admin' });
  });
});

describe('one member: their page, and suspending them', () => {
  it('needs an admin and a fresh confirmation, and opening it is on the audit log', async () => {
    const w = await build();
    expect((await w.app.inject({ method: 'GET', url: '/admin/members/member', headers: w.member })).statusCode).toBe(403);
    const unconfirmed = await w.app.inject({ method: 'GET', url: '/admin/members/member', headers: w.op });
    expect(unconfirmed.statusCode).toBe(403);
    expect(unconfirmed.json().error).toBe('step_up_required');
    await w.stepUp.grant(RESERVED_OPERATOR_USER_ID);
    expect((await w.app.inject({ method: 'GET', url: '/admin/members/nobody', headers: w.op })).statusCode).toBe(404);
    const page = await w.app.inject({ method: 'GET', url: '/admin/members/member', headers: w.op });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ member: { id: 'member', role: 'USER', status: 'ACTIVE' }, wallets: [{ label: 'Main' }], mints: { settled: 3, confirmed: 2 } });
    expect(page.json().member).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(page.json())).not.toMatch(/encryptedPrivateKey|wrappedDek/);
    expect(w.audit.entries.filter((e) => e.action === 'admin.view_user')).toEqual([expect.objectContaining({ targetUserId: 'member', actorUserId: RESERVED_OPERATOR_USER_ID })]);
  });

  it('suspending ends every session, stops their schedules, and is on the audit log; unsuspending reverses it', async () => {
    const w = await build();
    const laptop = { authorization: `Bearer ${await w.sessions.create('member')}` };
    await w.stepUp.grant(RESERVED_OPERATOR_USER_ID);
    const res = await w.app.inject({ method: 'POST', url: '/admin/members/member/suspend', headers: w.op, payload: { reason: 'spam' } });
    expect(res.json()).toEqual({ status: 'SUSPENDED', sessionsEnded: 2 });
    expect((await w.users.findById('member'))!.status).toBe('SUSPENDED');
    for (const h of [w.member, laptop]) expect((await w.app.inject({ method: 'GET', url: '/auth/me', headers: h })).statusCode).toBe(401);
    expect(w.stops).toEqual(['stop member: account suspended: spam']);
    expect(w.audit.entries.find((e) => e.action === 'admin.suspend_user')).toMatchObject({ targetUserId: 'member', detail: 'spam; 2 sessions ended' });
    // A sign-in that was already under way hands out a session a moment later: it is dead on arrival.
    const late = { authorization: `Bearer ${await w.sessions.create('member')}` };
    expect((await w.app.inject({ method: 'GET', url: '/auth/me', headers: late })).statusCode).toBe(401);
    // Again: the account stays suspended, and every step runs once more rather than being skipped.
    const stopsBefore = w.stops.length;
    expect((await w.app.inject({ method: 'POST', url: '/admin/members/member/suspend', headers: w.op, payload: {} })).json()).toEqual({ status: 'SUSPENDED', sessionsEnded: 0 });
    expect(w.stops.length).toBe(stopsBefore + 1);
    expect(w.audit.entries.filter((e) => e.action === 'admin.suspend_user')).toHaveLength(1);

    const back = await w.app.inject({ method: 'POST', url: '/admin/members/member/unsuspend', headers: w.op });
    expect(back.json()).toEqual({ status: 'ACTIVE' });
    expect((await w.users.findById('member'))!.status).toBe('ACTIVE');
    expect(w.stops.at(-1)).toBe('clear member');
    expect(w.audit.entries.some((e) => e.action === 'admin.unsuspend_user')).toBe(true);
    // Signing in works again.
    const again = { authorization: `Bearer ${await w.sessions.create('member')}` };
    expect((await w.app.inject({ method: 'GET', url: '/auth/me', headers: again })).statusCode).toBe(200);
  });

  it('a suspension that failed half way is finished by trying again', async () => {
    const w = await build();
    await w.stepUp.grant(RESERVED_OPERATOR_USER_ID);
    // The first try marked the account suspended, then died before ending its sessions.
    await w.users.setStatus('member', 'SUSPENDED');
    const res = await w.app.inject({ method: 'POST', url: '/admin/members/member/suspend', headers: w.op, payload: { reason: 'spam' } });
    expect(res.json()).toMatchObject({ status: 'SUSPENDED', sessionsEnded: 1 });
    expect(w.stops).toEqual(['stop member: account suspended: spam']);
    expect(w.audit.entries.find((e) => e.action === 'admin.suspend_user')).toMatchObject({ detail: 'repeated; spam; 1 session ended' });
  });

  it('will not suspend an admin, yourself, or without a fresh confirmation; checks the reason', async () => {
    const w = await build();
    const suspend = (id: string, payload: object = {}) => w.app.inject({ method: 'POST', url: `/admin/members/${id}/suspend`, headers: w.op, payload });
    expect((await suspend('member')).json().error).toBe('step_up_required');
    await w.stepUp.grant(RESERVED_OPERATOR_USER_ID);
    expect((await suspend(RESERVED_OPERATOR_USER_ID)).json().error).toBe('cannot_suspend_self');
    const at = new Date();
    w.users.seed({ id: 'other-admin', email: null, passwordHash: null, role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: true, createdAt: at, updatedAt: at });
    expect((await suspend('other-admin')).json().error).toBe('cannot_suspend_admin');
    expect((await suspend('member', { reason: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await w.users.findById('member'))!.status).toBe('ACTIVE');
    expect(w.stops).toEqual([]);
  });
});
