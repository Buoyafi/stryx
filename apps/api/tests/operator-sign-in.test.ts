import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { UserAccountService } from '@stryx/user-service';
import { noopLogger } from '@stryx/logger';
import { InProcessEventBus } from '@stryx/event-bus';
import { buildApp } from '../src/app.js';
import type { OperatorTokenMode } from '../src/auth.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { RedisSessionStore } from '../src/session-store.js';
import { SiweService } from '../src/siwe-service.js';
import { AccessCodeService } from '../src/access-code-service.js';
import { SessionCookie } from '../src/session-cookie.js';
import { RedisRateLimiter } from '../src/rate-limiter.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { adminCaller } from '../src/admin-guard.js';
import { adoptWallet, capAccount, describeAdmins, grantAdmin, revokeAdmin, uncapAccount, type AdminAccount, type OperatorAdminStore } from '../src/operator-admin.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryIdentityRepository } from './fakes/in-memory-identity-repository.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';

const TOKEN = { authorization: 'Bearer test-operator-token' };
const ORIGIN = 'https://app.stryx.test';
const SAME = { origin: ORIGIN };
const HOUR = 3_600_000;

function build(tokenMode?: OperatorTokenMode) {
  const kms = new LocalKeyManagementProvider();
  const users = new InMemoryUserRepository();
  const now = new Date();
  users.seed({ id: RESERVED_OPERATOR_USER_ID, email: 'operator@stryx.local', passwordHash: 'disabled', role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: false, createdAt: now, updatedAt: now });
  const redis = new InMemoryRedisClient();
  const identity = new InMemoryIdentityRepository(users);
  const app = buildApp({
    walletService: new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId),
    logger: noopLogger,
    authToken: 'test-operator-token',
    ...(tokenMode ? { operatorTokenMode: tokenMode } : {}),
    userAccountService: new UserAccountService(users),
    sessions: new RedisSessionStore(redis),
    auditLogService: new AuditLogService(new InMemoryAuditLogRepository(), new InProcessEventBus(), noopLogger),
    walletSignIn: {
      appOrigin: ORIGIN,
      siwe: new SiweService(redis, ORIGIN),
      codes: new AccessCodeService(identity, redis, 'x'.repeat(40)),
      identity,
      sessionCookie: new SessionCookie(ORIGIN),
      limiter: new RedisRateLimiter(redis),
    },
  });
  /** What operator:adopt does, on the in-memory identity store. */
  const adopt = (address: string) => identity.wallets.set(address.toLowerCase(), { id: `w-${address}`, userId: RESERVED_OPERATOR_USER_ID, address, lastUsedAt: null });
  return { app, identity, users, adopt };
}

async function signIn(app: FastifyInstance, account: ReturnType<typeof privateKeyToAccount>, ticket?: string) {
  const challenge = await app.inject({ method: 'POST', url: '/auth/siwe/challenge', headers: SAME, payload: { address: account.address, chainId: 1 } });
  const message = challenge.json().siweMessage as string;
  const signature = await account.signMessage({ message });
  return app.inject({ method: 'POST', url: '/auth/siwe/verify', headers: SAME, payload: { message, signature, ...(ticket ? { ticket } : {}) } });
}
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;
const maxAgeOf = (res: { headers: Record<string, unknown> }) => Number(/Max-Age=(\d+)/.exec(String(res.headers['set-cookie']))![1]);

afterEach(() => {
  vi.useRealTimers();
});

describe('the operator signs in with a wallet', () => {
  it('an adopted wallet lands on the operator account, with its admin pages', async () => {
    const { app, adopt } = build('off');
    const operatorWallet = privateKeyToAccount(generatePrivateKey());
    adopt(operatorWallet.address);
    const res = await signIn(app, operatorWallet);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: RESERVED_OPERATOR_USER_ID, role: 'ADMIN' });
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieOf(res) } });
    expect(me.json()).toMatchObject({ id: RESERVED_OPERATOR_USER_ID, signedInWith: 'wallet' });
    expect((await app.inject({ method: 'GET', url: '/admin/access-codes', headers: { cookie: cookieOf(res) } })).statusCode).toBe(200);
  });

  it("an admin's session ends after 1 hour idle", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, adopt } = build();
    const w = privateKeyToAccount(generatePrivateKey());
    adopt(w.address);
    const res = await signIn(app, w);
    expect(maxAgeOf(res)).toBe(12 * 3600); // the cookie itself goes after 12 hours
    const cookie = { cookie: cookieOf(res) };
    vi.setSystemTime(Date.now() + 59 * 60_000);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: cookie })).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: cookie })).statusCode).toBe(401);
  });

  it("an admin's session ends after 12 hours however busy", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, adopt } = build();
    const w = privateKeyToAccount(generatePrivateKey());
    adopt(w.address);
    const cookie = { cookie: cookieOf(await signIn(app, w)) };
    const start = Date.now();
    let status = 200;
    for (let t = 50; t <= 13 * 60 && status === 200; t += 50) {
      vi.setSystemTime(start + t * 60_000);
      status = (await app.inject({ method: 'GET', url: '/auth/me', headers: cookie })).statusCode;
      if (t < 12 * 60) expect(status).toBe(200);
    }
    expect(status).toBe(401);
  });

  it("a member's session is unchanged: days long, and fine after hours idle", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app } = build();
    const code = (await app.inject({ method: 'POST', url: '/admin/access-codes', headers: TOKEN, payload: {} })).json().code;
    const ticket = (await app.inject({ method: 'POST', url: '/auth/code/check', headers: SAME, payload: { code } })).json().ticket;
    const res = await signIn(app, privateKeyToAccount(generatePrivateKey()), ticket);
    expect(res.json().user.role).toBe('USER');
    expect(maxAgeOf(res)).toBe(30 * 24 * 3600);
    vi.setSystemTime(Date.now() + 5 * HOUR);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieOf(res) } })).statusCode).toBe(200);
  });
});

describe('what the operator API token may do', () => {
  it("'admin' (development's default): everything, admin pages included", async () => {
    const { app } = build('admin');
    expect((await app.inject({ method: 'GET', url: '/admin/access-codes', headers: TOKEN })).statusCode).toBe(200);
  });

  it("'api': acts as the operator for its own data, but never passes an admin check", async () => {
    const { app } = build('api');
    expect((await app.inject({ method: 'GET', url: '/wallets', headers: TOKEN })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: TOKEN })).json()).toMatchObject({ id: RESERVED_OPERATOR_USER_ID });
    for (const [method, url] of [['GET', '/admin/access-codes'], ['POST', '/admin/access-codes'], ['POST', '/admin/access-codes/x/revoke']] as const) {
      expect((await app.inject({ method, url, headers: TOKEN, ...(method === 'POST' ? { payload: {} } : {}) })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("'off' (production's default): the token is not accepted anywhere", async () => {
    const { app } = build('off');
    for (const url of ['/wallets', '/auth/me', '/admin/access-codes']) {
      expect((await app.inject({ method: 'GET', url, headers: TOKEN })).statusCode, url).toBe(401);
    }
  });
});

describe('the one admin check', () => {
  const req = (over: Record<string, unknown> = {}) => ({ userId: 'u1', ...over }) as never;
  const find = (role: string, status = 'ACTIVE') => async () => ({ role, status });
  it('needs an active ADMIN, read fresh each time, and never the token in api mode', async () => {
    expect(await adminCaller(req(), find('ADMIN'))).not.toBeNull();
    expect(await adminCaller(req(), find('USER'))).toBeNull();
    expect(await adminCaller(req(), find('ADMIN', 'SUSPENDED'))).toBeNull(); // a suspended admin acts as nobody
    expect(await adminCaller(req({ adminDenied: true }), find('ADMIN'))).toBeNull();
    expect(await adminCaller(req({ userId: undefined }), find('ADMIN'))).toBeNull();
  });
});

describe('the operator scripts', () => {
  function store() {
    const wallets = new Map<string, string>(); // addressLower -> userId
    const users = new Map<string, { id: string; role: string; status: string; displayName: string | null; spendCapEnabled: boolean }>([[RESERVED_OPERATOR_USER_ID, { id: RESERVED_OPERATOR_USER_ID, role: 'ADMIN', status: 'ACTIVE', displayName: null, spendCapEnabled: false }]]);
    const audit: { action: string; targetUserId: string; detail: string }[] = [];
    const s: OperatorAdminStore = {
      findSignInWallet: async (a) => (wallets.has(a) ? { userId: wallets.get(a)! } : null),
      addSignInWallet: async (userId, address) => void wallets.set(address.toLowerCase(), userId),
      listSignInAddresses: async (userId) => [...wallets].filter(([, u]) => u === userId).map(([a]) => a),
      getUser: async (id) => users.get(id) ?? null,
      setRole: async (id, role) => void (users.get(id)!.role = role),
      setSpendCapEnabled: async (id, enabled) => void (users.get(id)!.spendCapEnabled = enabled),
      listAdmins: async () => [...users.values()].filter((u) => u.role === 'ADMIN').map((u): AdminAccount => ({ id: u.id, displayName: u.displayName, addresses: [...wallets].filter(([, x]) => x === u.id).map(([a]) => a), spendCapEnabled: u.spendCapEnabled })),
      audit: async (e) => void audit.push(e),
    };
    return { s, wallets, users, audit };
  }
  const A = '0x' + 'a'.repeat(40);
  const B = '0x' + 'b'.repeat(40);

  it('adopt: a fresh wallet joins the operator account, once, with an audit row and a nudge to add a second', async () => {
    const { s, audit } = store();
    const first = await adoptWallet(s, A);
    expect(first).toMatchObject({ ok: true });
    expect(first.message).toMatch(/now signs in to the operator account \(1 wallet\).*second wallet/);
    expect(await adoptWallet(s, A)).toMatchObject({ ok: true, message: expect.stringMatching(/already signs in to the operator account/) });
    expect((await adoptWallet(s, B)).message).not.toMatch(/second wallet/);
    expect(audit.map((a) => a.action)).toEqual(['operator.adopt_wallet', 'operator.adopt_wallet']);
  });

  it("adopt refuses a wallet that already belongs to someone else's account, and a non-address", async () => {
    const { s, wallets } = store();
    wallets.set(A, 'someone');
    expect(await adoptWallet(s, A)).toMatchObject({ ok: false, message: expect.stringMatching(/another account/) });
    expect(await adoptWallet(s, 'not-an-address')).toMatchObject({ ok: false });
    expect(await adoptWallet(s, undefined)).toMatchObject({ ok: false });
  });

  it('grant and revoke change the role of the account a wallet signs in to, never leaving no admin', async () => {
    const { s, wallets, users, audit } = store();
    users.set('bob', { id: 'bob', role: 'USER', status: 'ACTIVE', displayName: 'Bob', spendCapEnabled: true });
    wallets.set(B, 'bob');
    expect(await grantAdmin(s, A)).toMatchObject({ ok: false, message: expect.stringMatching(/sign in to Stryx once/) });
    expect(await grantAdmin(s, B)).toMatchObject({ ok: true });
    expect(users.get('bob')!.role).toBe('ADMIN');
    expect((await describeAdmins(s)).message).toMatch(/2 admin accounts[\s\S]*"Bob"/);
    expect(await revokeAdmin(s, B, { tokenIsAdmin: true })).toMatchObject({ ok: true });
    expect(users.get('bob')!.role).toBe('USER');
    wallets.set(A, RESERVED_OPERATOR_USER_ID);
    expect(await revokeAdmin(s, A, { tokenIsAdmin: true })).toMatchObject({ ok: false, message: expect.stringMatching(/last admin/) });
    expect(users.get(RESERVED_OPERATOR_USER_ID)!.role).toBe('ADMIN');
    expect(audit.map((a) => a.action)).toEqual(['role.grant', 'role.revoke']);
  });

  it('revoke does not count the operator account as a remaining admin when it cannot reach the admin pages', async () => {
    const { s, wallets, users } = store();
    users.set('bob', { id: 'bob', role: 'ADMIN', status: 'ACTIVE', displayName: 'Bob', spendCapEnabled: true });
    wallets.set(B, 'bob');
    // The operator row is an admin with no sign-in wallet, and the API token does not act as admin.
    expect(await revokeAdmin(s, B)).toMatchObject({ ok: false, message: expect.stringMatching(/last admin account that can reach the admin pages/) });
    expect(await revokeAdmin(s, B, { tokenIsAdmin: false })).toMatchObject({ ok: false });
    expect(users.get('bob')!.role).toBe('ADMIN');

    // Once the operator account has a wallet to sign in with, somebody is left.
    await adoptWallet(s, A);
    expect(await revokeAdmin(s, B)).toMatchObject({ ok: true });
    expect(users.get('bob')!.role).toBe('USER');
  });

  it('revoke counts a second admin only if it has a wallet to sign in with', async () => {
    const { s, wallets, users } = store();
    users.set('bob', { id: 'bob', role: 'ADMIN', status: 'ACTIVE', displayName: 'Bob', spendCapEnabled: true });
    users.set('cy', { id: 'cy', role: 'ADMIN', status: 'ACTIVE', displayName: 'Cy', spendCapEnabled: true });
    wallets.set(B, 'bob');
    expect(await revokeAdmin(s, B)).toMatchObject({ ok: false });
    wallets.set('0x' + 'c'.repeat(40), 'cy');
    expect(await revokeAdmin(s, B)).toMatchObject({ ok: true });
  });

  it('grant refuses a suspended account', async () => {
    const { s, wallets, users } = store();
    users.set('sus', { id: 'sus', role: 'USER', status: 'SUSPENDED', displayName: null, spendCapEnabled: true });
    wallets.set(B, 'sus');
    expect(await grantAdmin(s, B)).toMatchObject({ ok: false, message: expect.stringMatching(/suspended/) });
  });

  it('uncap turns off an admin account\'s spend caps (members never), cap and revoke turn them back on, all audited', async () => {
    const { s, wallets, users, audit } = store();
    users.set('ade', { id: 'ade', role: 'USER', status: 'ACTIVE', displayName: 'Ade', spendCapEnabled: true });
    wallets.set(B, 'ade');
    expect(await uncapAccount(s, B)).toMatchObject({ ok: false, message: expect.stringMatching(/Only admin accounts/) });
    expect(users.get('ade')!.spendCapEnabled).toBe(true);
    await grantAdmin(s, B);
    expect(await uncapAccount(s, B)).toMatchObject({ ok: true, message: expect.stringMatching(/no daily spend caps/) });
    expect(users.get('ade')!.spendCapEnabled).toBe(false);
    expect(await uncapAccount(s, B)).toMatchObject({ ok: true, message: expect.stringMatching(/Nothing changed/) });
    expect((await describeAdmins(s)).message).toMatch(/"Ade": .*\(no spend caps\)/);
    expect(await capAccount(s, B)).toMatchObject({ ok: true });
    expect(users.get('ade')!.spendCapEnabled).toBe(true);
    await uncapAccount(s, B);
    expect((await revokeAdmin(s, B, { tokenIsAdmin: true })).message).toMatch(/spend caps are back on/);
    expect(users.get('ade')!.spendCapEnabled).toBe(true);
    expect(audit.map((a) => a.action)).toEqual(['role.grant', 'spend_cap.disable', 'spend_cap.enable', 'spend_cap.disable', 'role.revoke', 'spend_cap.enable']);
    expect(await uncapAccount(s, 'nope')).toMatchObject({ ok: false });
  });
});
