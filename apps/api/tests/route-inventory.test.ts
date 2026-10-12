import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import { WALLET_SIGN_IN_PUBLIC_PATHS, type OperatorTokenMode } from '../src/auth.js';
import { isTermsExempt, isTermsGated } from '../src/terms-controller.js';
import { UserAccountService } from '@stryx/user-service';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { RedisSessionStore } from '../src/session-store.js';
import { SessionCookie } from '../src/session-cookie.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';

/** Route inventory (ADR-003 §7 step 3). */
const PUBLIC: ReadonlySet<string> = new Set([
  'GET /health',
  // Account creation and sign-in: there is nothing to authenticate with yet.
  'POST /auth/signup', // closed by SIGNUP_ENABLED unless deliberately opened
  'POST /auth/login',
  'GET /auth/options',
  'POST /auth/code/check',
  'POST /auth/siwe/challenge',
  'POST /auth/siwe/verify',
  // The Home feed a visitor sees before entering a code.
  'GET /home/drops',
  // The landing page's waitlist sign-up: an email in, nothing out (it never says who is on the list).
  'POST /waitlist',
]);

const APP_ORIGIN = 'https://app.stryx.test';
// Anything reached on a stub returns the stub, and calling it does too, so nothing throws at build.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub });

function buildEverything(tokenMode?: OperatorTokenMode): FastifyInstance {
  // Real accounts (the operator is ADMIN), so the admin checks below decide on the role, not on a stub.
  const users = new InMemoryUserRepository();
  const now = new Date();
  users.seed({ id: RESERVED_OPERATOR_USER_ID, email: 'operator@stryx.local', passwordHash: 'disabled', role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: false, createdAt: now, updatedAt: now });
  return buildApp({
    walletService: stub,
    logger: noopLogger,
    authToken: 'operator-token',
    ...(tokenMode ? { operatorTokenMode: tokenMode } : {}),
    userAccountService: new UserAccountService(users),
    sessions: new RedisSessionStore(new InMemoryRedisClient()),
    auditLogService: stub,
    mintExecutionService: stub,
    mintPreviewService: stub,
    mintBatchService: stub,
    mintScheduler: stub,
    autoScheduleService: stub,
    balanceService: stub,
    disperseService: stub,
    chainServices: new Map([[1, stub]]),
    openSeaResolver: stub,
    mintEligibilityService: stub,
    stepUpStore: stub,
    vaultSettingsService: stub,
    nftLedgerService: stub,
    walletKeyExportService: stub,
    dropsFeedService: stub,
    waitlist: { service: stub, limiter: stub },
    mintLog: stub,
    platformStats: stub,
    signedMint: stub,
    emergencyStopGuard: stub,
    userRepository: users,
    nftHoldingsService: stub,
    nftTransferService: stub,
    walletSignIn: { appOrigin: APP_ORIGIN, siwe: stub, codes: stub, identity: stub, sessionCookie: new SessionCookie(APP_ORIGIN), limiter: stub },
  });
}

/** Every "METHOD /path" Fastify has, from its route tree (HEAD is Fastify's automatic twin of GET). */
function listRoutes(app: FastifyInstance): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^([│ ]*)[├└]── (\S+)(?: \(([^)]+)\))?/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    const path = stack.join('');
    for (const method of (m[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (method !== 'HEAD') out.push(`${method} ${path}`);
    }
  }
  return out;
}

/** A concrete URL for a route pattern: path parameters filled with plausible values. */
const concrete = (path: string) =>
  path.replace(/:chainId/g, '1').replace(/:(contract|walletId)/g, '0x' + '1'.repeat(40)).replace(/:hash/g, '0x' + 'a'.repeat(64)).replace(/:[A-Za-z]+/g, 'some-id');

describe('route inventory', () => {
  it('sees the whole API (so a pass below means something)', async () => {
    const app = buildEverything();
    await app.ready();
    const routes = listRoutes(app);
    expect(routes.length).toBeGreaterThan(60);
    for (const r of ['POST /wallets/:id/export-key', 'DELETE /schedules/mints/:jobId', 'POST /admin/access-codes/:id/revoke', 'PUT /vault-settings', 'POST /wallets/disperse', 'GET /me/mints', 'GET /admin/overview', 'GET /admin/audit', 'GET /admin/waitlist', 'DELETE /admin/waitlist/:id']) {
      expect(routes).toContain(r);
    }
    for (const r of PUBLIC) expect(routes).toContain(r); // nothing on the public list has gone stale
  });

  it('every route that is not on the public list refuses a caller with no credentials', async () => {
    const app = buildEverything();
    await app.ready();
    const open: string[] = [];
    for (const route of listRoutes(app)) {
      if (PUBLIC.has(route)) continue;
      const [method, path] = route.split(' ') as [string, string];
      const res = await app.inject({ method: method as 'GET', url: concrete(path), headers: { origin: APP_ORIGIN }, ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }) });
      if (res.statusCode !== 401) open.push(`${route} -> ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });

  it('a made-up session cookie and a wrong bearer token are refused too', async () => {
    const app = buildEverything();
    await app.ready();
    const cookie = await app.inject({ method: 'GET', url: '/wallets', headers: { cookie: `__Host-stryx_session=${'a'.repeat(64)}` } });
    expect(cookie.statusCode).toBe(401);
    const bearer = await app.inject({ method: 'GET', url: '/wallets', headers: { authorization: 'Bearer not-the-token' } });
    expect(bearer.statusCode).toBe(401);
  });

  it("with the operator token in 'api' mode, every /admin route refuses it; in 'admin' mode none does", async () => {
    const run = async (mode: OperatorTokenMode) => {
      const app = buildEverything(mode);
      await app.ready();
      const refused: string[] = [];
      const admin = listRoutes(app).filter((r) => r.split(' ')[1]!.startsWith('/admin'));
      expect(admin.length).toBeGreaterThan(5);
      for (const route of admin) {
        const [method, path] = route.split(' ') as [string, string];
        const res = await app.inject({ method: method as 'GET', url: concrete(path), headers: { authorization: 'Bearer operator-token' }, ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }) });
        if (res.statusCode === 403) refused.push(route);
      }
      return { admin, refused };
    };
    const api = await run('api');
    expect(api.refused).toEqual(api.admin);
    expect((await run('admin')).refused).toEqual([]);
  });

  it('every route that changes something is classified for terms acceptance, exactly once (gated or exempt)', async () => {
    const app = buildEverything();
    await app.ready();
    const unclassified: string[] = [];
    const both: string[] = [];
    for (const route of listRoutes(app)) {
      const [method, path] = route.split(' ') as [string, string];
      if (method === 'GET') continue;
      const gated = isTermsGated(method, concrete(path));
      const exempt = isTermsExempt(method, concrete(path));
      if (!gated && !exempt) unclassified.push(route);
      if (gated && exempt) both.push(route);
    }
    // A new write route has to be added to TERMS_GATED or TERMS_EXEMPT in terms-controller.ts, on purpose.
    expect(unclassified).toEqual([]);
    expect(both).toEqual([]);
  });

  it('the auth layer and this test agree on which paths are public', () => {
    const paths = new Set([...PUBLIC].map((r) => r.split(' ')[1]));
    for (const p of WALLET_SIGN_IN_PUBLIC_PATHS) expect(paths.has(p)).toBe(true);
  });
});
