import { describe, expect, it, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import { StepUpStore } from '../src/step-up-store.js';
import { VaultSettingsService } from '../src/vault-settings.service.js';
import { NftLedgerService } from '../src/nft-ledger.service.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryVaultSettingsRepository } from './fakes/in-memory-vault-settings-repository.js';
import { InMemoryNftLedgerRepository } from './fakes/in-memory-nft-ledger-repository.js';

const TOKEN = 'test-secret-token-12345';
const CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890';
const VAULT = '0x9999999999999999999999999999999999999999';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function buildTestApp(nftLedgerRepo = new InMemoryNftLedgerRepository()): FastifyInstance {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  return buildApp({
    walletService,
    logger: noopLogger,
    authToken: TOKEN,
    stepUpStore: new StepUpStore(new InMemoryRedisClient()),
    vaultSettingsService: new VaultSettingsService(new InMemoryVaultSettingsRepository()),
    nftLedgerService: new NftLedgerService(nftLedgerRepo),
  });
}

describe('GET /vault-settings', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildTestApp();
  });

  it('requires auth like every other route', async () => {
    const res = await app.inject({ method: 'GET', url: `/vault-settings?chainId=${CHAIN_ID}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns a disabled shape with no lastDrainFailure for a chain nobody has configured', async () => {
    const res = await app.inject({ method: 'GET', url: `/vault-settings?chainId=${CHAIN_ID}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, vaultAddress: null, lastDrainFailure: null });
  });

  it('surfaces the most recent unresolved drain failure for this owner on this chain', async () => {
    const nftLedgerRepo = new InMemoryNftLedgerRepository();
    await nftLedgerRepo.create({ walletId: 'w1', ownerId: RESERVED_OPERATOR_USER_ID, chainId: CHAIN_ID, contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' });
    await nftLedgerRepo.recordDrainFailure({ walletId: 'w1', chainId: CHAIN_ID, contract: CONTRACT, tokenId: '1' }, 'Simulation reverted: boom');
    const app2 = buildTestApp(nftLedgerRepo);

    const res = await app2.inject({ method: 'GET', url: `/vault-settings?chainId=${CHAIN_ID}`, headers: AUTH });
    expect(res.json().lastDrainFailure).toMatchObject({ contract: CONTRACT, tokenId: '1', error: 'Simulation reverted: boom' });
  });
});

describe('PUT /vault-settings (step-up gated)', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildTestApp();
  });

  const putBody = { chainId: CHAIN_ID, enabled: true, vaultAddress: VAULT };

  it('refuses without a live step-up grant', async () => {
    const res = await app.inject({ method: 'PUT', url: '/vault-settings', headers: AUTH, payload: putBody });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('step_up_required');
  });

  it('rejects step-up with the wrong credential', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/step-up', headers: AUTH, payload: { credential: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('succeeds once step-up has been granted with the correct credential', async () => {
    const stepUp = await app.inject({ method: 'POST', url: '/auth/step-up', headers: AUTH, payload: { credential: TOKEN } });
    expect(stepUp.statusCode).toBe(200);

    const res = await app.inject({ method: 'PUT', url: '/vault-settings', headers: AUTH, payload: putBody });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, vaultAddress: VAULT });

    const get = await app.inject({ method: 'GET', url: `/vault-settings?chainId=${CHAIN_ID}`, headers: AUTH });
    expect(get.json()).toMatchObject({ enabled: true, vaultAddress: VAULT });
  });

  it('rejects enabling with no vault address, even with a step-up grant', async () => {
    await app.inject({ method: 'POST', url: '/auth/step-up', headers: AUTH, payload: { credential: TOKEN } });

    const res = await app.inject({
      method: 'PUT',
      url: '/vault-settings',
      headers: AUTH,
      payload: { chainId: CHAIN_ID, enabled: true, vaultAddress: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('vault_address_required');
  });
});
