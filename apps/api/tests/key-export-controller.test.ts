import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { InProcessEventBus } from '@stryx/event-bus';
import { buildApp } from '../src/app.js';
import { StepUpStore } from '../src/step-up-store.js';
import { RedisSessionStore } from '../src/session-store.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { WalletKeyExportService } from '../src/wallet-key-export.service.js';
import { WalletKeyRecordProviderAdapter } from '../src/wallet-key-record-provider.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';

const TOKEN = 'test-secret-token-12345';
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function setup() {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);
  const wallet = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);
  const redis = new InMemoryRedisClient();
  const sessions = new RedisSessionStore(redis);
  const auditRepo = new InMemoryAuditLogRepository();
  const app = buildApp({
    walletService,
    logger: noopLogger,
    authToken: TOKEN,
    sessions,
    stepUpStore: new StepUpStore(redis),
    auditLogService: new AuditLogService(auditRepo, new InProcessEventBus(), noopLogger),
    walletKeyExportService: new WalletKeyExportService(walletService, walletKeyService, new WalletKeyRecordProviderAdapter(repository)),
  });
  const stepUp = () => app.inject({ method: 'POST', url: '/auth/step-up', headers: AUTH, payload: { credential: TOKEN } });
  const exportKey = (id = wallet.id, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'POST', url: `/wallets/${id}/export-key`, headers });
  return { app, wallet, sessions, auditRepo, stepUp, exportKey };
}

describe('POST /wallets/:id/export-key', () => {
  it('refuses without a step-up grant', async () => {
    const { exportKey } = await setup();
    const res = await exportKey();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('step_up_required');
  });

  it('returns the real key for this wallet after step-up, uncached', async () => {
    const { wallet, stepUp, exportKey } = await setup();
    await stepUp();
    const res = await exportKey();

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { address, privateKey } = res.json();
    expect(address).toBe(wallet.address);
    expect(privateKeyToAccount(privateKey).address.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('consumes the grant: a second export needs its own re-confirmation', async () => {
    const { stepUp, exportKey } = await setup();
    await stepUp();
    expect((await exportKey()).statusCode).toBe(200);
    expect((await exportKey()).statusCode).toBe(403);
  });

  it('one confirmation reveals one key, however many requests arrive together', async () => {
    const { stepUp, exportKey } = await setup();
    await stepUp();
    const codes = (await Promise.all([exportKey(), exportKey(), exportKey(), exportKey()])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 403, 403, 403]);
  });

  it('404s for a wallet that does not exist', async () => {
    const { stepUp, exportKey } = await setup();
    await stepUp();
    expect((await exportKey('no-such-wallet')).statusCode).toBe(404);
  });

  it('is refused for a user-dashboard session, even with a valid session', async () => {
    const { sessions, exportKey, wallet } = await setup();
    const sessionToken = await sessions.create('some-user');
    const res = await exportKey(wallet.id, { authorization: `Bearer ${sessionToken}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('operator_only');
  });

  it('audits the export without ever recording the key', async () => {
    const { auditRepo, stepUp, exportKey, wallet } = await setup();
    await stepUp();
    const { privateKey } = (await exportKey()).json();

    const entry = auditRepo.entries.find((e) => e.action === 'wallet.export_key');
    expect(entry).toMatchObject({ walletId: wallet.id, outcome: 'success' });
    expect(JSON.stringify(auditRepo.entries)).not.toContain(privateKey.slice(2));
  });
});
