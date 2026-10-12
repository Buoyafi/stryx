import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import { OpenSeaResolver, type FetchLike } from '../src/opensea-resolver.js';
import type { ChainServices } from '../src/chain-services.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';

const TEST_CHAIN_ID = 8453; // base: matches the fake API responses below

function fakeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => body });
}

async function buildRig(opts: { resolverFetch: FetchLike; configuredChains: number[] }) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);

  const chainServices = new Map<number, ChainServices>();
  for (const id of opts.configuredChains) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chainServices.set(id, {} as any);
  }

  const openSeaResolver = new OpenSeaResolver(opts.resolverFetch, 'test-key');

  const app: FastifyInstance = buildApp({
    walletService,
    logger: noopLogger,
    openSeaResolver,
    chainServices,
  });

  return { app };
}

describe('resolve controller', () => {
  it('resolves a collection and reports mintableHere=true when the chain is configured', async () => {
    const { app } = await buildRig({
      resolverFetch: fakeFetch({ contracts: [{ address: '0x1234567890123456789012345678901234567890', chain: 'base' }] }),
      configuredChains: [TEST_CHAIN_ID],
    });

    const res = await app.inject({ method: 'POST', url: '/resolve/opensea', payload: { input: 'https://opensea.io/collection/some-drop' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.contract).toBe('0x1234567890123456789012345678901234567890');
    expect(body.chainId).toBe(TEST_CHAIN_ID);
    expect(body.mintableHere).toBe(true);
  });

  it('reports mintableHere=false with a note when the chain is not configured here', async () => {
    const { app } = await buildRig({
      resolverFetch: fakeFetch({ contracts: [{ address: '0x1234567890123456789012345678901234567890', chain: 'base' }] }),
      configuredChains: [], // nothing configured
    });

    const res = await app.inject({ method: 'POST', url: '/resolve/opensea', payload: { input: 'https://opensea.io/collection/some-drop' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().mintableHere).toBe(false);
    expect(res.json().note).toContain('no RPC configured');
  });

  it('reports chainId null and a note for an unsupported chain', async () => {
    const { app } = await buildRig({
      resolverFetch: fakeFetch({ contracts: [{ address: '0x1234567890123456789012345678901234567890', chain: 'zora' }] }),
      configuredChains: [TEST_CHAIN_ID],
    });

    const res = await app.inject({ method: 'POST', url: '/resolve/opensea', payload: { input: 'https://opensea.io/collection/zora-drop' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().chainId).toBeNull();
    expect(res.json().note).toContain('does not support');
  });

  it('returns 422 for an unparseable input', async () => {
    const { app } = await buildRig({ resolverFetch: fakeFetch({}), configuredChains: [TEST_CHAIN_ID] });

    const res = await app.inject({ method: 'POST', url: '/resolve/opensea', payload: { input: 'https://example.com/nope' } });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('resolve_failed');
  });

  it('returns 400 for a missing input field', async () => {
    const { app } = await buildRig({ resolverFetch: fakeFetch({}), configuredChains: [TEST_CHAIN_ID] });

    const res = await app.inject({ method: 'POST', url: '/resolve/opensea', payload: {} });

    expect(res.statusCode).toBe(400);
  });
});
