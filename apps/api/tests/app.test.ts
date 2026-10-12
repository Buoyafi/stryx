import { describe, expect, it, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';

function buildTestApp(): FastifyInstance {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);
  return buildApp({ walletService, logger: noopLogger });
}

describe('apps/api', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildTestApp();
  });

  it('GET /health returns ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('creates and retrieves a wallet through the fully composed app', async () => {
    const created = await app.inject({ method: 'POST', url: '/wallets', payload: { label: 'Test' } });
    expect(created.statusCode).toBe(201);
    const { id, address } = created.json();

    const fetched = await app.inject({ method: 'GET', url: `/wallets/${id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().address).toBe(address);
  });

  it('maps a Zod validation error to a 400 with issue details', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/wallets',
      payload: { tier: 'NOT_A_REAL_TIER' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('validation_error');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('returns 404 for a wallet that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/wallets/nonexistent-id' });
    expect(response.statusCode).toBe(404);
  });
});
