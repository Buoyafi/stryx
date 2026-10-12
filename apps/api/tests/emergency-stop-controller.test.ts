import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { UserAccountService } from '@stryx/user-service';
import { EmergencyStopGuard } from '@stryx/transaction-engine';
import { InProcessEventBus } from '@stryx/event-bus';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { RedisSessionStore } from '../src/session-store.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';

const OPERATOR_TOKEN = 'test-operator-token';

async function buildTestApp(auditLogRepository?: InMemoryAuditLogRepository): Promise<{
  app: FastifyInstance;
  userRepository: InMemoryUserRepository;
  emergencyStopGuard: EmergencyStopGuard;
}> {
  const walletRepository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(walletRepository, new WalletKeyService(kms), kms.keyId);

  const userRepository = new InMemoryUserRepository();
  const userAccountService = new UserAccountService(userRepository);
  const sessions = new RedisSessionStore(new InMemoryRedisClient());
  const emergencyStopGuard = new EmergencyStopGuard(new InMemoryRedisClient());

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
    emergencyStopGuard,
    userRepository,
    // This suite signs up its own test users to get a session; unrelated to what it's actually
    // testing, so signup is enabled here deliberately.
    signupEnabled: true,
    ...(auditLogService ? { auditLogService } : {}),
  });
  return { app, userRepository, emergencyStopGuard };
}

async function signupUser(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple' },
  });
  return res.json().token as string;
}

describe('emergency stop controller (ADR-002 §3.7)', () => {
  it('a user can trigger a stop on their own account, self-service, no admin involved', async () => {
    const { app, emergencyStopGuard } = await buildTestApp();
    const token = await signupUser(app, 'self-stop@example.com');
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    const userId = me.json().id as string;

    expect(await emergencyStopGuard.isStopped('any-wallet', userId)).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/emergency-stop/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'I think my session token leaked' },
    });

    expect(res.statusCode).toBe(200);
    expect(await emergencyStopGuard.isStopped('any-wallet', userId)).toBe(true);
  });

  it('a self-triggered stop halts every wallet under that user, but leaves other users unaffected', async () => {
    const { app, emergencyStopGuard } = await buildTestApp();
    const tokenA = await signupUser(app, 'user-a@example.com');
    const tokenB = await signupUser(app, 'user-b@example.com');
    const meA = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${tokenA}` } });
    const meB = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${tokenB}` } });
    const userIdA = meA.json().id as string;
    const userIdB = meB.json().id as string;

    await app.inject({
      method: 'POST',
      url: '/emergency-stop/me',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { reason: 'testing isolation' },
    });

    expect(await emergencyStopGuard.isStopped('wallet-1', userIdA)).toBe(true);
    expect(await emergencyStopGuard.isStopped('wallet-2', userIdA)).toBe(true); // every wallet, not just one
    expect(await emergencyStopGuard.isStopped('wallet-1', userIdB)).toBe(false); // other user unaffected
  });

  it('there is no self-service clear route: a non-admin user cannot lift their own stop', async () => {
    const { app, emergencyStopGuard } = await buildTestApp();
    const token = await signupUser(app, 'cant-self-clear@example.com');
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    const userId = me.json().id as string;

    await app.inject({
      method: 'POST',
      url: '/emergency-stop/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'account may be compromised' },
    });
    expect(await emergencyStopGuard.isStopped('w1', userId)).toBe(true);

    // The only route that can clear a user-scoped stop is the ADMIN one, a non-admin calling it is
    // refused, and the stop remains active.
    const attempt = await app.inject({
      method: 'DELETE',
      url: `/admin/emergency-stop/users/${userId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(attempt.statusCode).toBe(403);
    expect(await emergencyStopGuard.isStopped('w1', userId)).toBe(true);
  });

  it('an admin CAN clear a stop the user triggered on themselves', async () => {
    const { app, emergencyStopGuard } = await buildTestApp();
    const token = await signupUser(app, 'gets-rescued@example.com');
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    const userId = me.json().id as string;

    await app.inject({
      method: 'POST',
      url: '/emergency-stop/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'account may be compromised' },
    });
    expect(await emergencyStopGuard.isStopped('w1', userId)).toBe(true);

    const clear = await app.inject({
      method: 'DELETE',
      url: `/admin/emergency-stop/users/${userId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }, // operator = ADMIN
    });
    expect(clear.statusCode).toBe(200);
    expect(await emergencyStopGuard.isStopped('w1', userId)).toBe(false);
  });

  it('a non-admin is refused (403) on every /admin/emergency-stop/* route, and nothing changes', async () => {
    const { app, emergencyStopGuard } = await buildTestApp();
    const token = await signupUser(app, 'not-an-admin@example.com');

    const globalTrigger = await app.inject({
      method: 'POST',
      url: '/admin/emergency-stop/global',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'trying my luck' },
    });
    expect(globalTrigger.statusCode).toBe(403);
    expect(await emergencyStopGuard.isStopped('any-wallet', 'any-user')).toBe(false);

    const walletTrigger = await app.inject({
      method: 'POST',
      url: '/admin/emergency-stop/wallets/some-wallet',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'trying my luck' },
    });
    expect(walletTrigger.statusCode).toBe(403);
    expect(await emergencyStopGuard.isStopped('some-wallet', 'any-user')).toBe(false);
  });

  it('an admin can trigger and clear a global stop', async () => {
    const { app, emergencyStopGuard } = await buildTestApp();

    const trigger = await app.inject({
      method: 'POST',
      url: '/admin/emergency-stop/global',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { reason: 'platform-wide incident' },
    });
    expect(trigger.statusCode).toBe(200);
    expect(await emergencyStopGuard.isStopped('any-wallet', 'any-user')).toBe(true);

    const clear = await app.inject({
      method: 'DELETE',
      url: '/admin/emergency-stop/global',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(clear.statusCode).toBe(200);
    expect(await emergencyStopGuard.isStopped('any-wallet', 'any-user')).toBe(false);
  });

  it('an admin can trigger and clear a wallet-scoped stop, affecting only that wallet', async () => {
    const { app, emergencyStopGuard } = await buildTestApp();

    const trigger = await app.inject({
      method: 'POST',
      url: '/admin/emergency-stop/wallets/hot-wallet-1',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { reason: 'suspicious outbound tx' },
    });
    expect(trigger.statusCode).toBe(200);
    expect(await emergencyStopGuard.isStopped('hot-wallet-1', 'any-user')).toBe(true);
    expect(await emergencyStopGuard.isStopped('hot-wallet-2', 'any-user')).toBe(false);

    const clear = await app.inject({
      method: 'DELETE',
      url: '/admin/emergency-stop/wallets/hot-wallet-1',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(clear.statusCode).toBe(200);
    expect(await emergencyStopGuard.isStopped('hot-wallet-1', 'any-user')).toBe(false);
  });

  it('records audit entries for self-trigger, admin trigger/clear, and a denied non-admin attempt (ADR-002 §3.10)', async () => {
    const auditLog = new InMemoryAuditLogRepository();
    const { app } = await buildTestApp(auditLog);
    const token = await signupUser(app, 'audited@example.com');
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    const userId = me.json().id as string;

    await app.inject({
      method: 'POST',
      url: '/emergency-stop/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'self stop' },
    });
    await app.inject({
      method: 'DELETE',
      url: `/admin/emergency-stop/users/${userId}`,
      headers: { authorization: `Bearer ${token}` }, // denied, not admin
    });
    await app.inject({
      method: 'DELETE',
      url: `/admin/emergency-stop/users/${userId}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }, // admin clears it
    });

    // Filter out the signup entry from user-auth-controller: this test only cares about emergency-stop actions.
    const actions = auditLog.entries.filter((e) => e.action.startsWith('emergency_stop.')).map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual([
      'emergency_stop.trigger.user:success',
      'emergency_stop.admin_action_denied:failure',
      'emergency_stop.clear.user:success',
    ]);
    expect(auditLog.entries.find((e) => e.action === 'emergency_stop.trigger.user')?.actorUserId).toBe(userId);
    expect(auditLog.entries.find((e) => e.action === 'emergency_stop.clear.user')?.actorUserId).toBe(
      RESERVED_OPERATOR_USER_ID,
    );
  });
});
