import { describe, expect, it } from 'vitest';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { UserAccountService } from '@stryx/user-service';
import { noopLogger } from '@stryx/logger';
import { InProcessEventBus } from '@stryx/event-bus';
import { buildApp } from '../src/app.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { RedisRateLimiter } from '../src/rate-limiter.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { WaitlistService } from '../src/waitlist.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';
import { InMemoryWaitlistRepository } from './fakes/in-memory-waitlist-repository.js';
import type { OperatorTokenMode } from '../src/auth.js';

const OPERATOR = { authorization: 'Bearer test-operator-token' };

function build(tokenMode?: OperatorTokenMode, trustProxy?: number) {
  const kms = new LocalKeyManagementProvider();
  const users = new InMemoryUserRepository();
  const now = new Date();
  users.seed({ id: RESERVED_OPERATOR_USER_ID, email: 'operator@stryx.local', passwordHash: 'disabled', role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: false, createdAt: now, updatedAt: now });
  const redis = new InMemoryRedisClient();
  const audit = new InMemoryAuditLogRepository();
  const repo = new InMemoryWaitlistRepository();
  const app = buildApp({
    walletService: new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId),
    logger: noopLogger,
    authToken: 'test-operator-token',
    ...(tokenMode ? { operatorTokenMode: tokenMode } : {}),
    userAccountService: new UserAccountService(users),
    auditLogService: new AuditLogService(audit, new InProcessEventBus(), noopLogger),
    waitlist: { service: new WaitlistService(repo), limiter: new RedisRateLimiter(redis) },
    ...(trustProxy !== undefined ? { trustProxy } : {}),
  });
  return { app, repo, audit, redis };
}

const join = (app: ReturnType<typeof build>['app'], payload: unknown, ip = '203.0.113.5') => app.inject({ method: 'POST', url: '/waitlist', payload: payload as object, remoteAddress: ip });

describe('POST /waitlist', () => {
  it('needs no login and stores a valid address', async () => {
    const { app, repo } = build();
    const res = await join(app, { email: 'Ada@Example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(repo.rows.map((r) => r.email)).toEqual(['Ada@Example.com']);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('gives the same answer for a new address and one already on the list, so it cannot be used to find who is on it', async () => {
    const { app, repo } = build();
    const first = await join(app, { email: 'a@b.io' });
    const again = await join(app, { email: 'A@B.io' });
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.body).toBe(first.body);
    expect(repo.rows).toHaveLength(1);
  });

  it('refuses things that are not an email, with a plain message', async () => {
    const { app, repo } = build();
    for (const payload of [{ email: 'nope' }, { email: '' }, { email: 7 }, {}, { email: 'a@b.io\nBcc: x@y.io' }]) {
      const res = await join(app, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_email', message: 'Enter a valid email address.' });
    }
    expect((await app.inject({ method: 'POST', url: '/waitlist', payload: 'not json', headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    expect(repo.rows).toHaveLength(0);
  });

  it('says yes to a script that fills in the hidden field, and stores nothing', async () => {
    const { app, repo } = build();
    const res = await join(app, { email: 'bot@spam.io', leave_blank: 'http://spam.example' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(repo.rows).toHaveLength(0);
    // an empty trap field is what a real browser sends
    expect((await join(app, { email: 'real@person.io', leave_blank: '' })).statusCode).toBe(200);
    expect(repo.rows).toHaveLength(1);
  });

  it('allows five tries an hour from one visitor, then asks them to wait; another visitor is unaffected', async () => {
    const { app } = build();
    for (let i = 0; i < 5; i++) expect((await join(app, { email: `p${i}@x.io` })).statusCode).toBe(200);
    const sixth = await join(app, { email: 'p5@x.io' });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('rate_limited');
    expect((await join(app, { email: 'other@x.io' }, '198.51.100.9')).statusCode).toBe(200);
  });

  it('one visitor hammering the form does not use up the hour for everyone else', async () => {
    const { app, redis } = build();
    for (let i = 0; i < 40; i++) await join(app, { email: `p${i}@x.io` });
    // Only the five that were let in count toward the limit all visitors share.
    const shared = new RedisRateLimiter(redis).keyFor('waitlist-all', 'all');
    expect(await redis.get(shared)).toBe('5');
  });

  it('keeps no visitor address in Redis: the limit is counted under a keyed hash of it', async () => {
    const { app, redis } = build();
    await join(app, { email: 'a@x.io' }, '203.0.113.77');
    const keys = redis.keys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(' ')).not.toContain('203.0.113.77');
    // Same visitor, same key; a different secret gives a different one, so it cannot be recomputed from the address alone.
    const key = new RedisRateLimiter(redis).keyFor('waitlist', '203.0.113.77');
    expect(keys).toContain(key);
    expect(new RedisRateLimiter(redis, 'ratelimit', 'another-secret').keyFor('waitlist', '203.0.113.77')).not.toBe(key);
  });

  it('with no proxy configured, a forwarded-for header is ignored: it cannot be used to dodge the limit', async () => {
    const { app } = build();
    const from = (fake: string) => app.inject({ method: 'POST', url: '/waitlist', payload: { email: `${fake}@x.io` }, remoteAddress: '203.0.113.5', headers: { 'x-forwarded-for': fake } });
    for (let i = 0; i < 5; i++) expect((await from(`198.51.100.${i}`)).statusCode).toBe(200);
    expect((await from('198.51.100.99')).statusCode).toBe(429);
  });

  it('behind one proxy, the visitor is the address that proxy added, not whatever the visitor wrote before it', async () => {
    const { app } = build(undefined, 1);
    // The proxy (the connection) appends the real address; the visitor controls only what comes before it.
    const from = (spoofed: string, real: string) =>
      app.inject({ method: 'POST', url: '/waitlist', payload: { email: 'a@x.io' }, remoteAddress: '10.0.0.2', headers: { 'x-forwarded-for': `${spoofed}, ${real}` } });
    for (let i = 0; i < 5; i++) expect((await from(`198.51.100.${i}`, '203.0.113.5')).statusCode).toBe(200);
    expect((await from('198.51.100.99', '203.0.113.5')).statusCode).toBe(429);
    // A different visitor through the same proxy is not affected.
    expect((await from('198.51.100.99', '203.0.113.6')).statusCode).toBe(200);
  });

  it('refuses a body over 2 kB', async () => {
    const { app, repo } = build();
    const res = await join(app, { email: 'a@b.io', pad: 'x'.repeat(5000) });
    expect(res.statusCode).toBe(413);
    expect(repo.rows).toHaveLength(0);
  });
});

describe('admin routes', () => {
  async function seed(app: ReturnType<typeof build>['app'], emails: string[]) {
    for (const [i, email] of emails.entries()) await join(app, { email }, `203.0.113.${i + 10}`);
  }

  it('refuse a caller with no login', async () => {
    const { app } = build();
    for (const [method, url] of [['GET', '/admin/waitlist'], ['GET', '/admin/waitlist/export'], ['POST', '/admin/waitlist/x/invited'], ['DELETE', '/admin/waitlist/x']] as const) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('refuse the operator token in api mode (not an admin session)', async () => {
    const { app } = build('api');
    for (const [method, url] of [['GET', '/admin/waitlist'], ['GET', '/admin/waitlist/export'], ['POST', '/admin/waitlist/x/invited'], ['DELETE', '/admin/waitlist/x']] as const) {
      const res = await app.inject({ method, url, headers: OPERATOR, ...(method === 'POST' ? { payload: { invited: true } } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('list newest first with counts, and filter by status', async () => {
    const { app } = build();
    await seed(app, ['one@x.io', 'two@x.io']);
    const all = (await app.inject({ method: 'GET', url: '/admin/waitlist', headers: OPERATOR })).json();
    expect(all.counts).toEqual({ waiting: 2, invited: 0 });
    expect(all.entries.map((e: { email: string }) => e.email)).toEqual(['two@x.io', 'one@x.io']);
    expect(all.entries[0]).toMatchObject({ status: 'waiting', invitedAt: null });
    await app.inject({ method: 'POST', url: `/admin/waitlist/${all.entries[1].id}/invited`, headers: OPERATOR, payload: { invited: true } });
    const invited = (await app.inject({ method: 'GET', url: '/admin/waitlist?status=invited', headers: OPERATOR })).json();
    expect(invited.entries.map((e: { email: string }) => e.email)).toEqual(['one@x.io']);
    expect(invited.entries[0].status).toBe('invited');
    expect((await app.inject({ method: 'GET', url: '/admin/waitlist?status=bogus', headers: OPERATOR })).statusCode).toBe(400);
  });

  it('mark and unmark invited, 404 for someone already removed, 400 for a bad body', async () => {
    const { app } = build();
    await seed(app, ['one@x.io']);
    const id = (await app.inject({ method: 'GET', url: '/admin/waitlist', headers: OPERATOR })).json().entries[0].id as string;
    const on = await app.inject({ method: 'POST', url: `/admin/waitlist/${id}/invited`, headers: OPERATOR, payload: { invited: true } });
    expect(on.json().entry).toMatchObject({ status: 'invited' });
    expect(on.json().entry.invitedAt).toBeTruthy();
    const off = await app.inject({ method: 'POST', url: `/admin/waitlist/${id}/invited`, headers: OPERATOR, payload: { invited: false } });
    expect(off.json().entry).toMatchObject({ status: 'waiting', invitedAt: null });
    expect((await app.inject({ method: 'POST', url: '/admin/waitlist/nope/invited', headers: OPERATOR, payload: { invited: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/admin/waitlist/${id}/invited`, headers: OPERATOR, payload: { invited: 'yes' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/admin/waitlist/${id}/invited`, headers: OPERATOR, payload: {} })).statusCode).toBe(400);
  });

  it('delete removes a person for good; a second delete is a 404', async () => {
    const { app, repo } = build();
    await seed(app, ['one@x.io']);
    const id = repo.rows[0]!.id;
    expect((await app.inject({ method: 'DELETE', url: `/admin/waitlist/${id}`, headers: OPERATOR })).statusCode).toBe(200);
    expect(repo.rows).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: `/admin/waitlist/${id}`, headers: OPERATOR })).statusCode).toBe(404);
  });

  it('export is a CSV download that is never cached and defuses formulas', async () => {
    const { app } = build();
    await seed(app, ['=cmd@x.io', 'ok@x.io']);
    const res = await app.inject({ method: 'GET', url: '/admin/waitlist/export', headers: OPERATOR });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('email,status,joined,invited,note');
    expect(lines).toHaveLength(3);
    expect(res.body).toContain(`'=cmd@x.io`);
    expect(lines.some((l) => l.startsWith('=cmd'))).toBe(false);
  });

  it('are on the audit log, and the log never holds an email address', async () => {
    const { app, audit } = build();
    await seed(app, ['secret.person@x.io']);
    const id = (await app.inject({ method: 'GET', url: '/admin/waitlist', headers: OPERATOR })).json().entries[0].id as string;
    await app.inject({ method: 'POST', url: `/admin/waitlist/${id}/invited`, headers: OPERATOR, payload: { invited: true } });
    await app.inject({ method: 'GET', url: '/admin/waitlist/export', headers: OPERATOR });
    await app.inject({ method: 'DELETE', url: `/admin/waitlist/${id}`, headers: OPERATOR });
    await new Promise((r) => setTimeout(r, 20));
    const actions = audit.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['waitlist.invite', 'waitlist.export', 'waitlist.delete']));
    expect(JSON.stringify(audit.entries)).not.toContain('secret.person');
    expect(JSON.stringify(audit.entries)).not.toContain('@x.io');
  });
});
