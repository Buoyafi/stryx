import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { UserAccountService } from '@stryx/user-service';
import { noopLogger } from '@stryx/logger';
import { InProcessEventBus } from '@stryx/event-bus';
import { buildApp } from '../src/app.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { RedisSessionStore } from '../src/session-store.js';
import { SiweService } from '../src/siwe-service.js';
import { AccessCodeService } from '../src/access-code-service.js';
import { SessionCookie } from '../src/session-cookie.js';
import { RedisRateLimiter } from '../src/rate-limiter.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { StepUpStore } from '../src/step-up-store.js';
import { TermsService } from '../src/terms.js';
import { isTermsGated } from '../src/terms-controller.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryIdentityRepository } from './fakes/in-memory-identity-repository.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';
import { InMemoryTermsRepository } from './fakes/in-memory-terms-repository.js';

const OPERATOR = { authorization: 'Bearer test-operator-token' };
const ORIGIN = 'https://app.stryx.test';
const SAME = { origin: ORIGIN };
const SECRET = 'x'.repeat(40);
const V1 = { termsVersion: '1.0', privacyVersion: '1.0' };
const V2 = { termsVersion: '2.0', privacyVersion: '1.0' };

function build(versions: typeof V1 | null = V1, shared?: { users: InMemoryUserRepository; redis: InMemoryRedisClient; identity: InMemoryIdentityRepository; terms: InMemoryTermsRepository; audit: InMemoryAuditLogRepository }) {
  const kms = new LocalKeyManagementProvider();
  const now = new Date();
  const users = shared?.users ?? new InMemoryUserRepository();
  if (!shared) users.seed({ id: RESERVED_OPERATOR_USER_ID, email: 'operator@stryx.local', passwordHash: 'disabled', role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: false, createdAt: now, updatedAt: now });
  const redis = shared?.redis ?? new InMemoryRedisClient();
  const identity = shared?.identity ?? new InMemoryIdentityRepository(users);
  const termsRepo = shared?.terms ?? new InMemoryTermsRepository();
  const audit = shared?.audit ?? new InMemoryAuditLogRepository();
  const app = buildApp({
    walletService: new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId),
    logger: noopLogger,
    authToken: 'test-operator-token',
    userAccountService: new UserAccountService(users),
    sessions: new RedisSessionStore(redis),
    auditLogService: new AuditLogService(audit, new InProcessEventBus(), noopLogger),
    stepUpStore: new StepUpStore(redis),
    terms: new TermsService(termsRepo, versions, SECRET),
    walletSignIn: { appOrigin: ORIGIN, siwe: new SiweService(redis, ORIGIN), codes: new AccessCodeService(identity, redis, SECRET), identity, sessionCookie: new SessionCookie(ORIGIN), limiter: new RedisRateLimiter(redis) },
  });
  return { app, users, redis, identity, terms: termsRepo, audit };
}

async function ticketFor(app: FastifyInstance): Promise<string> {
  const made = await app.inject({ method: 'POST', url: '/admin/access-codes', headers: OPERATOR, payload: {} });
  expect(made.statusCode).toBe(201);
  const check = await app.inject({ method: 'POST', url: '/auth/code/check', headers: SAME, payload: { code: made.json().code } });
  expect(check.statusCode).toBe(200);
  return check.json().ticket as string;
}

async function signIn(app: FastifyInstance, account: ReturnType<typeof privateKeyToAccount>, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const challenge = await app.inject({ method: 'POST', url: '/auth/siwe/challenge', headers: SAME, payload: { address: account.address, chainId: 1 } });
  const message = challenge.json().siweMessage as string;
  const signature = await account.signMessage({ message });
  return app.inject({ method: 'POST', url: '/auth/siwe/verify', headers: { ...SAME, ...headers }, payload: { message, signature, ...extra } });
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;

/** A signed-in member who ticked the box at sign-up. */
async function member(ctx: ReturnType<typeof build>, accept: typeof V1 | null = V1) {
  const account = privateKeyToAccount(generatePrivateKey());
  const res = await signIn(ctx.app, account, { ticket: await ticketFor(ctx.app), ...(accept ? { acceptedTerms: accept } : {}) });
  expect(res.statusCode).toBe(201);
  return { account, cookie: cookieOf(res), userId: res.json().user.id as string };
}

describe('what the sign-up screen is told', () => {
  it('the versions to accept when acceptance is on, null when it is off', async () => {
    expect((await build(V1).app.inject({ method: 'GET', url: '/auth/options' })).json()).toEqual({ walletSignIn: true, terms: V1 });
    expect((await build(null).app.inject({ method: 'GET', url: '/auth/options' })).json()).toEqual({ walletSignIn: true, terms: null });
  });
});

describe('creating an account requires the tick', () => {
  it('refuses a new account without acceptedTerms, names the versions, makes no account, and keeps the code usable', async () => {
    const ctx = build();
    const ticket = await ticketFor(ctx.app);
    const alice = privateKeyToAccount(generatePrivateKey());
    const refused = await signIn(ctx.app, alice, { ticket });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'terms_required', ...V1 });
    expect(refused.headers['set-cookie']).toBeUndefined();
    expect(await ctx.identity.findSignInWallet(alice.address.toLowerCase())).toBeNull();
    // the hold on the code is still there, so ticking and trying again works
    const ok = await signIn(ctx.app, alice, { ticket, acceptedTerms: V1 });
    expect(ok.statusCode).toBe(201);
  });

  it('refuses the wrong versions, whichever is off', async () => {
    const ctx = build();
    const ticket = await ticketFor(ctx.app);
    for (const wrong of [{ termsVersion: '0.9', privacyVersion: '1.0' }, { termsVersion: '1.0', privacyVersion: '0.9' }, { termsVersion: '1.0' }]) {
      const res = await signIn(ctx.app, privateKeyToAccount(generatePrivateKey()), { ticket, acceptedTerms: wrong });
      expect(res.statusCode, JSON.stringify(wrong)).toBe(400);
    }
  });

  it('records the acceptance as evidence, and logs it, when the account is made', async () => {
    const ctx = build();
    const { userId } = await member(ctx);
    expect(ctx.terms.rows).toHaveLength(1);
    const row = ctx.terms.rows[0]!;
    expect(row).toMatchObject({ userId, source: 'sign_up', ...V1 });
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.acceptedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.audit.entries.map((e) => e.action)).toContain('terms.accept');
  });

  it('records the browser that did it', async () => {
    const ctx = build();
    const account = privateKeyToAccount(generatePrivateKey());
    await signIn(ctx.app, account, { ticket: await ticketFor(ctx.app), acceptedTerms: V1 }, { 'user-agent': 'TestBrowser/9.1' });
    expect(ctx.terms.rows[0]!.userAgent).toBe('TestBrowser/9.1');
  });

  it('asks nothing of a returning wallet, and nothing of anyone when acceptance is off', async () => {
    const ctx = build();
    const { account } = await member(ctx);
    expect((await signIn(ctx.app, account)).statusCode).toBe(200);
    const off = build(null);
    expect((await signIn(off.app, privateKeyToAccount(generatePrivateKey()), { ticket: await ticketFor(off.app) })).statusCode).toBe(201);
    expect(off.terms.rows).toHaveLength(0);
  });
});

describe('the gate', () => {
  const create = (app: FastifyInstance, cookie: string) => app.inject({ method: 'POST', url: '/wallets', headers: { cookie, ...SAME }, payload: { label: 'w' } });

  it('lets an account that accepted carry on', async () => {
    const ctx = build();
    const { cookie } = await member(ctx);
    expect((await create(ctx.app, cookie)).statusCode).toBe(201);
  });

  it('stops an account that has not accepted from creating a wallet, and says why', async () => {
    const ctx = build(null);
    const { cookie, userId } = await member(ctx, null); // made while acceptance was off
    expect((await create(ctx.app, cookie)).statusCode).toBe(201);
    // acceptance is switched on later: the same account is now asked
    const later = build(V1, ctx);
    const res = await create(later.app, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'terms_not_accepted', ...V1 });
    expect(ctx.terms.rows.filter((r) => r.userId === userId)).toHaveLength(0);
  });

  it('still lets that account browse, and use the ways out (rename, delete, cancel, emergency stop)', async () => {
    const ctx = build(null);
    const { cookie } = await member(ctx, null);
    const later = build(V1, ctx);
    const h = { cookie, ...SAME };
    expect((await later.app.inject({ method: 'GET', url: '/wallets', headers: h })).statusCode).toBe(200);
    expect((await later.app.inject({ method: 'GET', url: '/auth/me', headers: h })).statusCode).toBe(200);
    for (const [method, url] of [['DELETE', '/wallets/nope'], ['PATCH', '/wallets/nope'], ['DELETE', '/schedules/mints/nope'], ['POST', '/emergency-stop/me'], ['POST', '/wallets/nope/export-key'], ['POST', '/wallets/disperse'], ['POST', '/wallets/nfts/transfer'], ['PATCH', '/me/profile']] as const) {
      const res = await later.app.inject({ method, url, headers: h, payload: {} });
      expect(res.json()?.error, `${method} ${url}`).not.toBe('terms_not_accepted');
    }
  });

  it('lists minting, scheduling and the other ways of starting something, by route as registered', () => {
    for (const [method, route] of [['POST', '/mints/seadrop/public'], ['POST', '/mints/seadrop/allowlist'], ['POST', '/mints/seadrop/batch'], ['POST', '/schedules/mints'], ['POST', '/schedules/mints/auto'], ['PATCH', '/schedules/mints/:id'], ['POST', '/signed-mints'], ['PUT', '/vault-settings'], ['POST', '/wallets'], ['POST', '/wallets/bulk'], ['POST', '/wallets/import']] as const) {
      expect(isTermsGated(method, route), `${method} ${route}`).toBe(true);
    }
    // Leaving is never gated: an account that has not accepted can still stop, withdraw and delete.
    expect(isTermsGated('DELETE', '/wallets/:id')).toBe(false);
    expect(isTermsGated('POST', '/wallets/:id/export-key')).toBe(false);
  });

  it('gates the routes it lists', async () => {
    const ctx = build(null);
    const { cookie } = await member(ctx, null);
    const later = build(V1, ctx);
    for (const [method, url] of [['POST', '/wallets'], ['POST', '/wallets/bulk'], ['POST', '/wallets/import']] as const) {
      const res = await later.app.inject({ method, url, headers: { cookie, ...SAME }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error, `${method} ${url}`).toBe('terms_not_accepted');
    }
  });

  it('gates by the route that runs, however the URL is written', async () => {
    const ctx = build(null);
    const { cookie } = await member(ctx, null);
    const later = build(V1, ctx);
    // Each of these reaches a gated route, though its text is not in the list as written.
    for (const url of ['/wallets/bul%6B', '/wallets/%62ulk', '/wallets/import?x=1', '/wallets?', '/wallets/bulk#x']) {
      const res = await later.app.inject({ method: 'POST', url, headers: { cookie, ...SAME }, payload: {} });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error, url).toBe('terms_not_accepted');
    }
    // No such route: nothing runs, so there is nothing to gate.
    expect((await later.app.inject({ method: 'POST', url: '/no/such/route', headers: { cookie, ...SAME }, payload: {} })).statusCode).toBe(404);
  });

  it('opens up the moment the account accepts', async () => {
    const ctx = build(null);
    const { cookie, userId } = await member(ctx, null);
    const later = build(V1, ctx);
    const h = { cookie, ...SAME };
    expect((await later.app.inject({ method: 'GET', url: '/me/terms', headers: h })).json()).toMatchObject({ required: true, accepted: false, ...V1 });
    const accepted = await later.app.inject({ method: 'POST', url: '/me/terms/accept', headers: h, payload: V1 });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, ...V1 });
    expect(ctx.terms.rows.filter((r) => r.userId === userId)).toMatchObject([{ source: 're_accept', ...V1 }]);
    expect((await create(later.app, cookie)).statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.audit.entries.map((e) => e.action)).toContain('terms.accept');
  });

  it('accepting twice records it once', async () => {
    const ctx = build(null);
    const { cookie } = await member(ctx, null);
    const later = build(V1, ctx);
    for (let i = 0; i < 2; i++) expect((await later.app.inject({ method: 'POST', url: '/me/terms/accept', headers: { cookie, ...SAME }, payload: V1 })).statusCode).toBe(200);
    expect(ctx.terms.rows).toHaveLength(1);
  });

  it('answers 409 with the current versions when the page was open across a change, and records nothing', async () => {
    const ctx = build(null);
    const { cookie } = await member(ctx, null);
    const later = build(V2, ctx);
    const res = await later.app.inject({ method: 'POST', url: '/me/terms/accept', headers: { cookie, ...SAME }, payload: V1 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'terms_changed', ...V2 });
    expect(ctx.terms.rows).toHaveLength(0);
    expect((await later.app.inject({ method: 'POST', url: '/me/terms/accept', headers: { cookie, ...SAME }, payload: { termsVersion: 1 } })).statusCode).toBe(400);
  });

  it('asks everyone again when a version changes', async () => {
    const ctx = build();
    const { cookie } = await member(ctx);
    expect((await create(ctx.app, cookie)).statusCode).toBe(201);
    const v2 = build(V2, ctx);
    expect((await create(v2.app, cookie)).statusCode).toBe(403);
    await v2.app.inject({ method: 'POST', url: '/me/terms/accept', headers: { cookie, ...SAME }, payload: V2 });
    expect((await create(v2.app, cookie)).statusCode).toBe(201);
    expect(ctx.terms.rows.map((r) => r.termsVersion)).toEqual(['1.0', '2.0']);
  });

  it('never gates the operator API token, and never gates anything when acceptance is off', async () => {
    const ctx = build();
    expect((await ctx.app.inject({ method: 'POST', url: '/wallets', headers: OPERATOR, payload: { label: 'op' } })).statusCode).toBe(201);
    const off = build(null);
    const { cookie } = await member(off, null);
    expect((await create(off.app, cookie)).statusCode).toBe(201);
    expect((await off.app.inject({ method: 'GET', url: '/me/terms', headers: { cookie, ...SAME } })).json()).toMatchObject({ required: false, accepted: true });
    expect((await off.app.inject({ method: 'POST', url: '/me/terms/accept', headers: { cookie, ...SAME }, payload: V1 })).statusCode).toBe(404);
  });

  it('is not bypassed by an anonymous request: the login check answers first', async () => {
    const ctx = build();
    expect((await ctx.app.inject({ method: 'POST', url: '/wallets', headers: SAME, payload: {} })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/me/terms' })).statusCode).toBe(401);
  });
});
