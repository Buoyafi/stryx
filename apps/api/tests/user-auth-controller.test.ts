import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { UserAccountService } from '@stryx/user-service';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { RedisSessionStore } from '../src/session-store.js';
import { InProcessEventBus } from '@stryx/event-bus';
import { AuditLogService } from '../src/audit-log-service.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';

const OPERATOR_TOKEN = 'test-operator-token';

async function buildTestApp(
  auditLogRepository?: InMemoryAuditLogRepository,
  // Every test in this file except the signup-gating block below is about what signup/login DO once
  // reachable, not about the gate itself, so it defaults open here.
  signupEnabled = true,
): Promise<{ app: FastifyInstance; userRepository: InMemoryUserRepository }> {
  const walletRepository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(walletRepository, new WalletKeyService(kms), kms.keyId);

  const userRepository = new InMemoryUserRepository();
  const userAccountService = new UserAccountService(userRepository);
  const sessions = new RedisSessionStore(new InMemoryRedisClient());

  // Mirrors what the migration seeds (ADR-002 §3.11): the fixed reserved operator id.
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

  const auditLogService = auditLogRepository
    ? new AuditLogService(auditLogRepository, new InProcessEventBus(), noopLogger)
    : undefined;

  const app = buildApp({
    walletService,
    logger: noopLogger,
    authToken: OPERATOR_TOKEN,
    userAccountService,
    sessions,
    signupEnabled,
    ...(auditLogService ? { auditLogService } : {}),
  });
  return { app, userRepository };
}

describe('user auth controller', () => {
  it('signs up, and the returned token immediately authenticates /auth/me', async () => {
    const { app } = await buildTestApp();

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'new-user@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(signup.statusCode).toBe(201);
    const { token, user } = signup.json();
    expect(user.email).toBe('new-user@example.com');
    expect(user).not.toHaveProperty('passwordHash');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('new-user@example.com');
  });

  it('rejects signup with an already-registered email', async () => {
    const { app } = await buildTestApp();
    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'dup@example.com', password: 'correct-horse-battery-staple' },
    });

    const second = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'dup@example.com', password: 'a-different-password' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    const { app } = await buildTestApp();
    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'login-user@example.com', password: 'correct-horse-battery-staple' },
    });

    const goodLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login-user@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(goodLogin.statusCode).toBe(200);
    expect(goodLogin.json().token).toBeTruthy();

    const badLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login-user@example.com', password: 'wrong-password' },
    });
    expect(badLogin.statusCode).toBe(401);
  });

  it('a session token reaches a wallet-owning route, scoped to that user, not the operator\'s wallets', async () => {
    const { app } = await buildTestApp();

    // Operator creates a wallet via the legacy token.
    await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { tier: 'HOT' },
    });

    // A real user signs up and lists wallets: must see none of the operator's.
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'isolated-user@example.com', password: 'correct-horse-battery-staple' },
    });
    const { token } = signup.json();

    const list = await app.inject({ method: 'GET', url: '/wallets', headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);

    // That user creates their OWN wallet via their session token.
    const created = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { authorization: `Bearer ${token}` },
      payload: { tier: 'HOT' },
    });
    expect(created.statusCode).toBe(201);

    const listAfter = await app.inject({ method: 'GET', url: '/wallets', headers: { authorization: `Bearer ${token}` } });
    expect(listAfter.json()).toHaveLength(1);

    // The operator's own view is unaffected, still just their one wallet.
    const operatorList = await app.inject({
      method: 'GET',
      url: '/wallets',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(operatorList.json()).toHaveLength(1);
  });

  it('logout revokes the session: the same token is rejected afterward', async () => {
    const { app } = await buildTestApp();
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'logout-user@example.com', password: 'correct-horse-battery-staple' },
    });
    const { token } = signup.json();

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
  });

  it('the operator (legacy bearer token) still works exactly as before, and /auth/me resolves to the operator account', async () => {
    const { app } = await buildTestApp();

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(RESERVED_OPERATOR_USER_ID);
    expect(me.json().role).toBe('ADMIN');
  });

  it('/auth/logout is a no-op (not an error) for a legacy-bearer-token request: there is no session to revoke', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
    expect(res.statusCode).toBe(204);

    // The shared token itself is unaffected, still works.
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
    expect(me.statusCode).toBe(200);
  });

  it('records audit entries for signup, login (success and failure), and logout (ADR-002 §3.10)', async () => {
    const auditLog = new InMemoryAuditLogRepository();
    const { app } = await buildTestApp(auditLog);

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'audited-user@example.com', password: 'correct-horse-battery-staple' },
    });
    const { token, user } = signup.json();

    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'audited-user@example.com', password: 'wrong-password' },
    });
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'audited-user@example.com', password: 'correct-horse-battery-staple' },
    });
    await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });

    const actions = auditLog.entries.map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual([
      'session.signup:success',
      'session.login:failure',
      'session.login:success',
      'session.logout:success',
    ]);
    // The successful entries carry the real user id; the failed login does NOT (see
    // user-auth-controller.ts's comment on why: no enumeration).
    expect(auditLog.entries[0]!.actorUserId).toBe(user.id);
    expect(auditLog.entries[1]!.actorUserId).toBeNull();
  });
});

describe('signup gating (SIGNUP_ENABLED)', () => {
  it('signup is closed by default: a caller that omits the flag entirely gets the safe behaviour, not an accidentally open signup', async () => {
    const walletRepository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(walletRepository, new WalletKeyService(kms), kms.keyId);
    const userAccountService = new UserAccountService(new InMemoryUserRepository());
    const sessions = new RedisSessionStore(new InMemoryRedisClient());

    // No `signupEnabled` key at all, the exact shape a caller that hasn't heard of this flag would produce.
    const app = buildApp({ walletService, logger: noopLogger, authToken: OPERATOR_TOKEN, userAccountService, sessions });

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'nope@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(signup.statusCode).toBe(403);
    expect(signup.json().error).toBe('signup_disabled');
  });

  it('signup is refused with the flag explicitly false, and creates no account', async () => {
    const { app, userRepository } = await buildTestApp(undefined, false);

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'still-nope@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(signup.statusCode).toBe(403);
    expect(await userRepository.findByEmail('still-nope@example.com')).toBeNull();
  });

  it('a closed signup is audited as a failure, with no actor to attribute it to', async () => {
    const auditLog = new InMemoryAuditLogRepository();
    const { app } = await buildTestApp(auditLog, false);

    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'audited-refusal@example.com', password: 'correct-horse-battery-staple' },
    });

    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0]!.action).toBe('session.signup');
    expect(auditLog.entries[0]!.outcome).toBe('failure');
    expect(auditLog.entries[0]!.actorUserId).toBeNull();
  });

  it('login is unaffected either way: an existing account keeps working while signup is closed', async () => {
    // The same user store served by two app instances, open then closed: an existing account still
    // signs in once sign-up is off.
    const walletRepository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(walletRepository, new WalletKeyService(kms), kms.keyId);
    const userRepository = new InMemoryUserRepository();
    const userAccountService = new UserAccountService(userRepository);
    const sessions = new RedisSessionStore(new InMemoryRedisClient());

    const openApp = buildApp({ walletService, logger: noopLogger, authToken: OPERATOR_TOKEN, userAccountService, sessions, signupEnabled: true });
    await openApp.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'already-had-an-account@example.com', password: 'correct-horse-battery-staple' },
    });

    const closedApp = buildApp({ walletService, logger: noopLogger, authToken: OPERATOR_TOKEN, userAccountService, sessions, signupEnabled: false });

    const login = await closedApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'already-had-an-account@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().token).toBeTruthy();

    const blockedSignup = await closedApp.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'a-new-one@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(blockedSignup.statusCode).toBe(403);
  });
});

describe('profile handles (PATCH /me/profile)', () => {
  const asOperator = { authorization: `Bearer ${OPERATOR_TOKEN}` };

  it('saves normalised handles, returns them on /auth/me, and clears one sent empty', async () => {
    const { app } = await buildTestApp();
    const saved = await app.inject({ method: 'PATCH', url: '/me/profile', headers: asOperator, payload: { discordHandle: '@Stryx.Ops', xHandle: '@stryx_xyz' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ discordHandle: 'stryx.ops', xHandle: 'stryx_xyz' });
    expect(saved.json()).not.toHaveProperty('passwordHash');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: asOperator });
    expect(me.json()).toMatchObject({ discordHandle: 'stryx.ops', xHandle: 'stryx_xyz' });

    // Only the field sent changes; an empty value clears it.
    const cleared = await app.inject({ method: 'PATCH', url: '/me/profile', headers: asOperator, payload: { xHandle: '' } });
    expect(cleared.json()).toMatchObject({ discordHandle: 'stryx.ops', xHandle: null });
  });

  it('refuses handles that are not handles, and saves nothing', async () => {
    const { app } = await buildTestApp();
    for (const payload of [{ xHandle: 'far_too_long_for_an_x_handle' }, { xHandle: 'has space' }, { discordHandle: 'a' }, { discordHandle: 'two..dots' }, { discordHandle: 'https://discord.gg/x' }]) {
      const res = await app.inject({ method: 'PATCH', url: '/me/profile', headers: asOperator, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_profile');
    }
    const unknown = await app.inject({ method: 'PATCH', url: '/me/profile', headers: asOperator, payload: { role: 'ADMIN' } });
    expect(unknown.statusCode).toBe(400); // no other field can be written through this route
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: asOperator });
    expect(me.json()).toMatchObject({ discordHandle: null, xHandle: null, role: 'ADMIN' });
  });

  it('saves a display name tidied, keeps it on /auth/me, and clears it when sent empty', async () => {
    const { app } = await buildTestApp();
    const saved = await app.inject({ method: 'PATCH', url: '/me/profile', headers: asOperator, payload: { displayName: '  Adé   Yusuf ' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ displayName: 'Adé Yusuf', discordHandle: null });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: asOperator })).json()).toMatchObject({ displayName: 'Adé Yusuf' });
    // Saving handles alone leaves the name alone.
    await app.inject({ method: 'PATCH', url: '/me/profile', headers: asOperator, payload: { xHandle: 'stryx_xyz' } });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: asOperator })).json()).toMatchObject({ displayName: 'Adé Yusuf', xHandle: 'stryx_xyz' });
    const cleared = await app.inject({ method: 'PATCH', url: '/me/profile', headers: asOperator, payload: { displayName: '   ' } });
    expect(cleared.json()).toMatchObject({ displayName: null });
  });

  it('refuses a display name that is too long or could carry a link or markup', async () => {
    const { app } = await buildTestApp();
    for (const displayName of ['x'.repeat(33), 'see https://evil.example', '<b>hi</b>', 'line\u0000break', '...', 'a@b']) {
      const res = await app.inject({ method: 'PATCH', url: '/me/profile', headers: asOperator, payload: { displayName } });
      expect(res.statusCode, displayName).toBe(400);
      expect(res.json().error).toBe('invalid_profile');
    }
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: asOperator })).json()).toMatchObject({ displayName: null });
  });

  it("writes only the caller's own profile, and needs a signed-in caller", async () => {
    const { app } = await buildTestApp();
    const signup = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: 'handles@example.com', password: 'correct-horse-battery-staple' } });
    const { token } = signup.json();
    await app.inject({ method: 'PATCH', url: '/me/profile', headers: { authorization: `Bearer ${token}` }, payload: { xHandle: 'someone' } });
    const operator = await app.inject({ method: 'GET', url: '/auth/me', headers: asOperator });
    expect(operator.json().xHandle).toBeNull();

    const anonymous = await app.inject({ method: 'PATCH', url: '/me/profile', payload: { xHandle: 'nobody' } });
    expect(anonymous.statusCode).toBe(401);
  });

  it('records an audit entry for a profile change', async () => {
    const auditLog = new InMemoryAuditLogRepository();
    const { app } = await buildTestApp(auditLog);
    await app.inject({ method: 'PATCH', url: '/me/profile', headers: asOperator, payload: { discordHandle: 'ops' } });
    expect(auditLog.entries.map((e) => `${e.action}:${e.outcome}`)).toEqual(['profile.update:success']);
  });
});
