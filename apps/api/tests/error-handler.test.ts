import { describe, expect, it } from 'vitest';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';

describe('the API\'s error handler, for a request the caller got wrong', () => {
  const app = (() => {
    const kms = new LocalKeyManagementProvider();
    return buildApp({ walletService: new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId), logger: noopLogger, authToken: 'test-operator-token' });
  })();
  const headers = { authorization: 'Bearer test-operator-token', 'content-type': 'application/json' };

  it('answers a body that is not valid JSON with a 400, not a 500', async () => {
    const res = await app.inject({ method: 'POST', url: '/wallets', headers, payload: '{"broken"' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: 'That request could not be read.' });
  });

  it('answers an unsupported content type with a 4xx, not a 500', async () => {
    const res = await app.inject({ method: 'POST', url: '/wallets', headers: { authorization: 'Bearer test-operator-token', 'content-type': 'application/x-weird' }, payload: 'x' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
