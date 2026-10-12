import { describe, expect, it, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';

const TOKEN = 'test-secret-token-12345';

async function buildAuthedApp(): Promise<FastifyInstance> {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);
  return buildApp({ walletService, logger: noopLogger, authToken: TOKEN });
}

describe('API auth (Level 1 token gate)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildAuthedApp();
  });

  it('allows /health with no token (public liveness check)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a protected route with no Authorization header', async () => {
    const res = await app.inject({ method: 'POST', url: '/wallets', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('rejects a malformed Authorization header (not Bearer)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { authorization: TOKEN }, // missing "Bearer " prefix
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { authorization: 'Bearer wrong-token' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token that is a prefix of the real one (length mismatch handled)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { authorization: 'Bearer test-secret' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows a protected route with the correct token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { tier: 'HOT' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('when no authToken is configured, routes are open (test/dev convenience)', async () => {
    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);
    const walletService = new WalletService(repository, walletKeyService, kms.keyId);
    const openApp = buildApp({ walletService, logger: noopLogger }); // no authToken

    const res = await openApp.inject({ method: 'POST', url: '/wallets', payload: { tier: 'HOT' } });
    expect(res.statusCode).toBe(201);
  });
});
