import { describe, expect, it } from 'vitest';
import { CollectionResolverService, CollectionResolveError } from '../src/collection-resolver.service.js';
import { OpenSeaResolver, OpenSeaResolveError } from '../src/opensea-resolver.js';
import type { FetchLike } from '../src/opensea-resolver.js';
import type { ChainServices } from '../src/chain-services.js';
import type { OpenSeaDropInfo } from '../src/opensea-drop-info.js';

const CONTRACT = '0x1234567890123456789012345678901234567890' as const;
const CODE = '0x6001600055';

function fakeServices(opts: { hasCode?: boolean; name?: string; getMintStats?: () => Promise<{ minterNumMinted: number; currentTotalSupply: bigint; maxSupply: bigint }> } = {}): ChainServices {
  return {
    publicClient: {
      getBytecode: async () => (opts.hasCode === false ? undefined : CODE),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'name') {
          if (opts.name === undefined) throw new Error('name() reverted');
          return opts.name;
        }
        throw new Error(`unexpected readContract call: ${functionName}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    seaDropReader: {
      getMintStats:
        opts.getMintStats ??
        (async () => {
          throw new Error('not a SeaDrop contract');
        }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionEngine: {} as any,
  };
}

const noOpenSeaFetch: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) });

function service(opts: { chainServices: Map<number, ChainServices>; fetchDropInfo?: (chainId: number, contract: string) => Promise<OpenSeaDropInfo | null>; openSeaFetch?: FetchLike }) {
  return new CollectionResolverService({
    openSeaResolver: new OpenSeaResolver(opts.openSeaFetch ?? noOpenSeaFetch, 'test-key'),
    chainServices: opts.chainServices,
    fetchDropInfo: opts.fetchDropInfo ?? (async () => null),
  });
}

describe('CollectionResolverService: bare contract address', () => {
  it('resolves straight through when exactly one configured chain has code there', async () => {
    const chainServices = new Map([[46630, fakeServices({ getMintStats: async () => ({ minterNumMinted: 0, currentTotalSupply: 3n, maxSupply: 100n }) })]]);
    const result = await service({ chainServices }).resolve(CONTRACT);
    if ('needsChainChoice' in result) throw new Error('expected a resolved collection');
    expect(result.chainId).toBe(46630);
    expect(result.contract).toBe(CONTRACT);
    expect(result.mintableHere).toBe(true);
    expect(result.mintedCount).toBe(3);
    expect(result.maxSupply).toBe(100);
  });

  it('asks for a chain choice when more than one configured chain has code there', async () => {
    const chainServices = new Map([
      [46630, fakeServices({ hasCode: true })],
      [4663, fakeServices({ hasCode: true })],
    ]);
    const result = await service({ chainServices }).resolve(CONTRACT);
    if (!('needsChainChoice' in result)) throw new Error('expected an ambiguous result');
    expect(result.needsChainChoice).toBe(true);
    expect(result.contract).toBe(CONTRACT);
    expect(result.chains.map((c) => c.chainId).sort()).toEqual([4663, 46630]);
  });

  it('does NOT ask when only one of several configured chains has code', async () => {
    const chainServices = new Map([
      [46630, fakeServices({ hasCode: true })],
      [4663, fakeServices({ hasCode: false })],
    ]);
    const result = await service({ chainServices }).resolve(CONTRACT);
    expect('needsChainChoice' in result).toBe(false);
  });

  it('throws contract_not_found when no configured chain has code there', async () => {
    const chainServices = new Map([[46630, fakeServices({ hasCode: false })]]);
    await expect(service({ chainServices }).resolve(CONTRACT)).rejects.toMatchObject({ code: 'contract_not_found' });
  });

  it('resolves directly to a chosen chainId (the second call after an ambiguous first one), re-verifying code is actually there', async () => {
    const chainServices = new Map([
      [46630, fakeServices({ hasCode: true })],
      [4663, fakeServices({ hasCode: true })],
    ]);
    const result = await service({ chainServices }).resolve(CONTRACT, 4663);
    if ('needsChainChoice' in result) throw new Error('expected a resolved collection');
    expect(result.chainId).toBe(4663);
  });

  it('rejects a chosen chainId that turns out to have no code there', async () => {
    const chainServices = new Map([[46630, fakeServices({ hasCode: false })]]);
    await expect(service({ chainServices }).resolve(CONTRACT, 46630)).rejects.toMatchObject({ code: 'contract_not_found' });
  });

  it('rejects a chosen chainId this instance has no RPC for at all', async () => {
    const chainServices = new Map([[46630, fakeServices()]]);
    await expect(service({ chainServices }).resolve(CONTRACT, 4663)).rejects.toMatchObject({ code: 'contract_not_found' });
  });
});

describe('CollectionResolverService: name, image and supply assembly', () => {
  const dropInfo: OpenSeaDropInfo = {
    collectionSlug: 'cool-drop',
    collectionName: 'Cool Drop',
    imageUrl: 'https://i.seadn.io/cool-drop.png',
    openSeaUrl: 'https://opensea.io/collection/cool-drop',
    totalSupply: 50,
    maxSupply: 1000,
    stages: [],
  };

  it('prefers OpenSea data when available: name, hotlinked image, and OpenSea supply as a starting point', async () => {
    const chainServices = new Map([[46630, fakeServices({ getMintStats: async () => ({ minterNumMinted: 0, currentTotalSupply: 7n, maxSupply: 999n }) })]]);
    const result = await service({ chainServices, fetchDropInfo: async () => dropInfo }).resolve(CONTRACT);
    if ('needsChainChoice' in result) throw new Error('unexpected');
    expect(result.name).toBe('Cool Drop');
    expect(result.image).toEqual({ kind: 'external', url: dropInfo.imageUrl });
    expect(result.slug).toBe('cool-drop');
    // On-chain wins over OpenSea's numbers when both are available.
    expect(result.mintedCount).toBe(7);
    expect(result.maxSupply).toBe(999);
  });

  it('falls back to on-chain name() and a proxied image URL when OpenSea has nothing, but the chain is mintable here', async () => {
    const chainServices = new Map([[46630, fakeServices({ name: 'On-Chain Name', getMintStats: async () => ({ minterNumMinted: 0, currentTotalSupply: 1n, maxSupply: 10n }) })]]);
    const result = await service({ chainServices, fetchDropInfo: async () => null }).resolve(CONTRACT);
    if ('needsChainChoice' in result) throw new Error('unexpected');
    expect(result.name).toBe('On-Chain Name');
    expect(result.image).toEqual({ kind: 'proxied', url: `/chains/46630/collections/${CONTRACT}/image` });
    expect(result.mintedCount).toBe(1);
  });

  it('shows contract/chain with everything else null when neither OpenSea nor on-chain name() has anything', async () => {
    const chainServices = new Map([[46630, fakeServices()]]); // no name(), no OpenSea
    const result = await service({ chainServices, fetchDropInfo: async () => null }).resolve(CONTRACT);
    if ('needsChainChoice' in result) throw new Error('unexpected');
    expect(result.name).toBeNull();
    expect(result.mintedCount).toBeNull();
    expect(result.maxSupply).toBeNull();
    // Still offers the proxied image URL: a contractURI might exist even though name() doesn't.
    expect(result.image).toEqual({ kind: 'proxied', url: `/chains/46630/collections/${CONTRACT}/image` });
  });

  it('a non-SeaDrop contract (getMintStats reverts) keeps whatever OpenSea reported, rather than erroring the whole resolve', async () => {
    const chainServices = new Map([[46630, fakeServices()]]); // getMintStats throws by default
    const result = await service({ chainServices, fetchDropInfo: async () => dropInfo }).resolve(CONTRACT);
    if ('needsChainChoice' in result) throw new Error('unexpected');
    expect(result.mintedCount).toBe(50); // OpenSea's number, since on-chain failed
    expect(result.maxSupply).toBe(1000);
  });
});

describe('CollectionResolverService: OpenSea URL / slug input', () => {
  it('delegates to OpenSeaResolver for a collection URL and assembles the result', async () => {
    const openSeaFetch: FetchLike = async (url) => {
      if (url.includes('/collections/cool-drop')) return { ok: true, status: 200, json: async () => ({ contracts: [{ address: CONTRACT, chain: 'robinhood_testnet' }] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const chainServices = new Map([[46630, fakeServices({ getMintStats: async () => ({ minterNumMinted: 0, currentTotalSupply: 1n, maxSupply: 2n }) })]]);
    const result = await service({ chainServices, openSeaFetch }).resolve('https://opensea.io/collection/cool-drop');
    if ('needsChainChoice' in result) throw new Error('unexpected');
    expect(result.contract.toLowerCase()).toBe(CONTRACT.toLowerCase());
    expect(result.chainId).toBe(46630);
  });

  it('never runs the multi-chain probe for OpenSea-shaped input: the chain is already known', async () => {
    let probed = false;
    const chainServices = new Map([
      [
        46630,
        {
          ...fakeServices(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          publicClient: { getBytecode: async () => { probed = true; return CODE; }, readContract: async () => { throw new Error('n/a'); } } as any,
        },
      ],
    ]);
    const openSeaFetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ contracts: [{ address: CONTRACT, chain: 'robinhood_testnet' }] }) });
    await service({ chainServices, openSeaFetch }).resolve('cool-drop');
    expect(probed).toBe(false);
  });

  it('surfaces OpenSeaResolveError for input OpenSeaResolver itself rejects', async () => {
    await expect(service({ chainServices: new Map() }).resolve('not a valid slug!!')).rejects.toBeInstanceOf(OpenSeaResolveError);
  });

  it('rejects with invalid_input when OpenSea names a chain this platform does not support at all', async () => {
    const openSeaFetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ contracts: [{ address: CONTRACT, chain: 'some-chain-we-have-never-heard-of' }] }) });
    await expect(service({ chainServices: new Map(), openSeaFetch }).resolve('cool-drop')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('still shows name/image from OpenSea for a chain we do not have RPC for, with mintableHere false and a note', async () => {
    // Ethereum (chainId 1) is a real, supported chain in the registry, just not one this fake instance has RPC for.
    const openSeaFetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ contracts: [{ address: CONTRACT, chain: 'ethereum' }] }) });
    const dropInfo: OpenSeaDropInfo = { collectionSlug: 'x', collectionName: 'X', imageUrl: 'https://i.seadn.io/x.png', openSeaUrl: null, totalSupply: 5, maxSupply: 10, stages: [] };
    const result = await service({ chainServices: new Map(), openSeaFetch, fetchDropInfo: async () => dropInfo }).resolve('cool-drop');
    if ('needsChainChoice' in result) throw new Error('unexpected');
    expect(result.mintableHere).toBe(false);
    expect(result.name).toBe('X');
    expect(result.mintedCount).toBe(5); // OpenSea's number: no RPC to read on-chain
    expect(result.note).toMatch(/no RPC configured/);
  });
});

describe('CollectionResolverService: input validation', () => {
  it('rejects empty input', async () => {
    await expect(service({ chainServices: new Map() }).resolve('   ')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('CollectionResolveError instances carry their code', async () => {
    try {
      await service({ chainServices: new Map() }).resolve('');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CollectionResolveError);
      expect((err as CollectionResolveError).code).toBe('invalid_input');
    }
  });
});

describe('CollectionResolverService: chain notes (phase B)', () => {
  it('SeaDrop not deployed: not mintable here, and the note says why', async () => {
    const svc = { ...fakeServices({ name: 'Thing' }), seaDropSupport: { isDeployed: async () => false } } as unknown as ChainServices;
    const result = await service({ chainServices: new Map([[2741, svc]]) }).resolve(CONTRACT, 2741);
    if ('needsChainChoice' in result) throw new Error('expected a resolved collection');
    expect(result.mintableHere).toBe(false);
    expect(result.note).toMatch(/Minting isn't supported on Abstract yet/);
    expect(result.name).toBe('Thing'); // still read on-chain: the RPC works
  });

  it('a chain OpenSea does not support: mintable, no OpenSea link, and a note saying phases come from the contract', async () => {
    const result = await service({ chainServices: new Map([[56, fakeServices({ name: 'Bnb Thing' })]]) }).resolve(CONTRACT, 56);
    if ('needsChainChoice' in result) throw new Error('expected a resolved collection');
    expect(result.mintableHere).toBe(true);
    expect(result.openSeaUrl).toBeNull();
    expect(result.note).toMatch(/OpenSea doesn't support BNB Chain/);
  });

  it('an unknown SeaDrop answer (RPC hiccup) does not block minting', async () => {
    const svc = { ...fakeServices({}), seaDropSupport: { isDeployed: async () => null } } as unknown as ChainServices;
    const result = await service({ chainServices: new Map([[1, svc]]) }).resolve(CONTRACT, 1);
    if ('needsChainChoice' in result) throw new Error('expected a resolved collection');
    expect(result.mintableHere).toBe(true);
    expect(result.note).toBeUndefined();
  });
});
