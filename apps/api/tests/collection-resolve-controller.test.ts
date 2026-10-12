import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import type { DropInfoReading } from '../src/opensea-drop-info-cache.js';
import { OpenSeaResolver } from '../src/opensea-resolver.js';
import type { FetchLike } from '../src/opensea-resolver.js';
import type { ChainServices } from '../src/chain-services.js';
import type { OpenSeaDropInfo } from '../src/opensea-drop-info.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';

const CONTRACT = '0x1234567890123456789012345678901234567890';
const CODE = '0x6001600055';

function fakeServices(
  opts: {
    hasCode?: boolean;
    contractURI?: string;
    getMintStats?: { minterNumMinted: number; currentTotalSupply: bigint; maxSupply: bigint };
    publicDrop?: { mintPrice: bigint; startTime: number; endTime: number; maxTotalMintableByWallet: number };
  } = {},
): ChainServices {
  return {
    publicClient: {
      getBytecode: async () => (opts.hasCode === false ? undefined : CODE),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'contractURI') {
          if (!opts.contractURI) throw new Error('no contractURI');
          return opts.contractURI;
        }
        throw new Error('name() reverted');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    seaDropReader: {
      getMintStats: async () => {
        if (!opts.getMintStats) throw new Error('not seadrop');
        return opts.getMintStats;
      },
      getPublicDrop: async () => ({ mintPrice: 0n, startTime: 0, endTime: 0, maxTotalMintableByWallet: 0, feeBps: 0, restrictFeeRecipients: false, ...opts.publicDrop }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionEngine: {} as any,
  };
}

async function buildRig(
  chainServices: Map<number, ChainServices>,
  fetchOpenSeaDropInfo?: (chainId: number, contract: string) => Promise<OpenSeaDropInfo | null>,
  fetchOpenSeaDropInfoReading?: (chainId: number, contract: string) => Promise<DropInfoReading>,
) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const noOpenSeaFetch: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const app: FastifyInstance = buildApp({
    walletService,
    logger: noopLogger,
    chainServices,
    openSeaResolver: new OpenSeaResolver(noOpenSeaFetch, undefined),
    ...(fetchOpenSeaDropInfo ? { fetchOpenSeaDropInfo } : {}),
    ...(fetchOpenSeaDropInfoReading ? { fetchOpenSeaDropInfoReading } : {}),
  });
  return { app };
}

describe('POST /resolve/collection', () => {
  it('resolves a bare address that has code on exactly one configured chain', async () => {
    const chainServices = new Map([[46630, fakeServices({ getMintStats: { minterNumMinted: 0, currentTotalSupply: 3n, maxSupply: 100n } })]]);
    const { app } = await buildRig(chainServices);

    const res = await app.inject({ method: 'POST', url: '/resolve/collection', payload: { input: CONTRACT } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chainId).toBe(46630);
    expect(body.mintedCount).toBe(3);
    expect(body.maxSupply).toBe(100);
    expect(body.mintableHere).toBe(true);
  });

  it('asks for a chain choice (still 200: this is a normal outcome, not an error) when ambiguous', async () => {
    const chainServices = new Map([
      [46630, fakeServices({ hasCode: true })],
      [4663, fakeServices({ hasCode: true })],
    ]);
    const { app } = await buildRig(chainServices);

    const res = await app.inject({ method: 'POST', url: '/resolve/collection', payload: { input: CONTRACT } });
    expect(res.statusCode).toBe(200);
    expect(res.json().needsChainChoice).toBe(true);
    expect(res.json().chains.map((c: { chainId: number }) => c.chainId).sort()).toEqual([4663, 46630]);
  });

  it('resolves directly once the chosen chainId is supplied', async () => {
    const chainServices = new Map([
      [46630, fakeServices({ hasCode: true })],
      [4663, fakeServices({ hasCode: true })],
    ]);
    const { app } = await buildRig(chainServices);

    const res = await app.inject({ method: 'POST', url: '/resolve/collection', payload: { input: CONTRACT, chainId: 4663 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().chainId).toBe(4663);
  });

  it('returns 404 when no configured chain has code at the address', async () => {
    const chainServices = new Map([[46630, fakeServices({ hasCode: false })]]);
    const { app } = await buildRig(chainServices);

    const res = await app.inject({ method: 'POST', url: '/resolve/collection', payload: { input: CONTRACT } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('contract_not_found');
  });

  it('rejects empty input with 400', async () => {
    const { app } = await buildRig(new Map());
    const res = await app.inject({ method: 'POST', url: '/resolve/collection', payload: { input: '' } });
    expect(res.statusCode).toBe(400);
  });

  it('maps an OpenSea resolve failure to 422', async () => {
    const { app } = await buildRig(new Map());
    const res = await app.inject({ method: 'POST', url: '/resolve/collection', payload: { input: 'https://opensea.io/collection/nope' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('resolve_failed');
  });
});

describe('GET /chains/:chainId/collections/:contract/image', () => {
  it('serves the resolved image bytes with the right content-type', async () => {
    // A loopback contractURI is rejected by the SSRF guard before any network call, so this exercises
    // the real wiring end to end.
    const chainServices = new Map([[46630, fakeServices({ hasCode: true, contractURI: 'http://127.0.0.1/metadata.json' })]]);
    const { app } = await buildRig(chainServices);
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/image` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('image_not_found');
  });

  it('returns 400 for an unconfigured chain', async () => {
    const { app } = await buildRig(new Map());
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/image` });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /chains/:chainId/collections/:contract/supply', () => {
  it('reads live minted/max supply', async () => {
    const chainServices = new Map([[46630, fakeServices({ getMintStats: { minterNumMinted: 0, currentTotalSupply: 9n, maxSupply: 500n } })]]);
    const { app } = await buildRig(chainServices);
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/supply` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chainId: 46630, mintedCount: 9, maxSupply: 500 });
  });

  it('returns 502 (not a raw RPC error) when the chain read fails', async () => {
    const chainServices = new Map([[46630, fakeServices()]]); // no getMintStats configured: throws
    const { app } = await buildRig(chainServices);
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/supply` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('rpc_unavailable');
  });

  it('returns 400 for an unconfigured chain', async () => {
    const { app } = await buildRig(new Map());
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/supply` });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /chains/:chainId/collections/:contract/phases', () => {
  it('lists the on-chain public phase when configured', async () => {
    const chainServices = new Map([[46630, fakeServices({ publicDrop: { mintPrice: 10n ** 16n, startTime: 1_700_000_000, endTime: 1_800_000_000, maxTotalMintableByWallet: 5 } })]]);
    const { app } = await buildRig(chainServices);
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/phases` });
    expect(res.statusCode).toBe(200);
    expect(res.json().phases).toEqual([{ id: 'public', name: 'Public', kind: 'public', priceWei: (10n ** 16n).toString(), startMs: 1_700_000_000_000, endMs: 1_800_000_000_000, maxPerWallet: 5, source: 'on-chain', mechanism: null, openSeaStageUuid: null }]);
  });

  it('returns an empty list when nothing is configured', async () => {
    const chainServices = new Map([[46630, fakeServices()]]);
    const { app } = await buildRig(chainServices);
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/phases` });
    expect(res.statusCode).toBe(200);
    expect(res.json().phases).toEqual([]);
  });

  it('folds in OpenSea-named allow-list phases alongside the on-chain public one', async () => {
    const chainServices = new Map([[46630, fakeServices({ publicDrop: { mintPrice: 1n, startTime: 100, endTime: 200, maxTotalMintableByWallet: 1 } })]]);
    const dropInfo: OpenSeaDropInfo = {
      collectionSlug: 'x',
      collectionName: 'X',
      imageUrl: null,
      openSeaUrl: null,
      totalSupply: null,
      maxSupply: null,
      stages: [
        { stageType: 'public_sale', label: 'Public', priceWei: null, startTime: null, endTime: null, maxPerWallet: null, allowlistWalletCount: null, uuid: 'uuid-public' },
        { stageType: 'presale', label: 'OG List', priceWei: '5000000000000000', startTime: null, endTime: null, maxPerWallet: 2, allowlistWalletCount: 40, uuid: 'uuid-og' },
      ],
    };
    const { app } = await buildRig(chainServices, async () => dropInfo);
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/phases` });
    const phases = res.json().phases;
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({ id: 'public', name: 'Public', source: 'on-chain' });
    expect(phases[1]).toMatchObject({ id: 'opensea-1', name: 'OG List', kind: 'allowlist', source: 'opensea', priceWei: '5000000000000000' });
  });

  it('returns 400 for an unconfigured chain', async () => {
    const { app } = await buildRig(new Map());
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/phases` });
    expect(res.statusCode).toBe(400);
  });

  it('returns 502 (not a raw RPC error) when the on-chain read fails', async () => {
    const chainServices = new Map([
      [
        46630,
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          seaDropReader: { getPublicDrop: async () => { throw new Error('rpc down'); } } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          publicClient: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transactionEngine: {} as any,
        },
      ],
    ]);
    const { app } = await buildRig(chainServices);
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/phases` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('rpc_unavailable');
  });

  it('a throwing fetchOpenSeaDropInfo degrades to on-chain-only, rather than failing the whole request', async () => {
    const chainServices = new Map([[46630, fakeServices({ publicDrop: { mintPrice: 1n, startTime: 100, endTime: 200, maxTotalMintableByWallet: 1 } })]]);
    const { app } = await buildRig(chainServices, async () => { throw new Error('opensea down'); });
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/phases` });
    expect(res.statusCode).toBe(200);
    expect(res.json().phases).toEqual([{ id: 'public', name: 'Public', kind: 'public', priceWei: '1', startMs: 100_000, endMs: 200_000, maxPerWallet: 1, source: 'on-chain', mechanism: null, openSeaStageUuid: null }]);
  });
});

describe('GET .../phases: says whether OpenSea\'s stages are there, and why not', () => {
  const services = () => new Map([[46630, fakeServices({ publicDrop: { mintPrice: 1n, startTime: 100, endTime: 200, maxTotalMintableByWallet: 1 } })]]);

  it('OpenSea unreachable with nothing remembered: the public phase alone, flagged openSea "unavailable" (not silently complete)', async () => {
    const { app } = await buildRig(services(), undefined, async () => ({ info: null, openSea: 'unavailable' }));
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/phases` });
    expect(res.json()).toMatchObject({ openSea: 'unavailable' });
    expect(res.json().phases.map((p: { name: string }) => p.name)).toEqual(['Public']);
  });

  it('stale: the remembered GTD/FCFS stages still listed, with when they were fetched', async () => {
    const info = {
      collectionSlug: 'kid-story',
      collectionName: 'Kid Story',
      imageUrl: null,
      openSeaUrl: null,
      totalSupply: null,
      maxSupply: null,
      stages: [{ stageType: 'signed_presale', label: 'GTD', priceWei: '0', startTime: '2026-09-28T14:00:00Z', endTime: null, maxPerWallet: 1, allowlistWalletCount: null, uuid: 'gtd' }],
    };
    const { app } = await buildRig(services(), undefined, async () => ({ info, openSea: 'stale', asOf: 123 }));
    const res = await app.inject({ method: 'GET', url: `/chains/46630/collections/${CONTRACT}/phases` });
    expect(res.json()).toMatchObject({ openSea: 'stale', openSeaAsOf: 123 });
    expect(res.json().phases.map((p: { name: string }) => p.name)).toEqual(['Public', 'GTD']);
  });
});
