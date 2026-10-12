// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiRequest: apiRequestMock,
  getToken: () => 'test-token',
}));

import { fetchCollectionSupply, fetchProxiedImageObjectUrl, isChainChoiceNeeded, resolveCollection, type CollectionResolution } from '../src/lib/collection-resolve';

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe('resolveCollection', () => {
  it('POSTs the input, and omits chainId when not given', async () => {
    apiRequestMock.mockResolvedValueOnce({ contract: '0xabc' });
    await resolveCollection('cool-drop');
    expect(apiRequestMock).toHaveBeenCalledWith('/resolve/collection', { method: 'POST', body: { input: 'cool-drop' } });
  });

  it('includes chainId when given, to disambiguate', async () => {
    apiRequestMock.mockResolvedValueOnce({ contract: '0xabc' });
    await resolveCollection('0xabc', 46630);
    expect(apiRequestMock).toHaveBeenCalledWith('/resolve/collection', { method: 'POST', body: { input: '0xabc', chainId: 46630 } });
  });
});

describe('isChainChoiceNeeded', () => {
  it('narrows an ambiguous result', () => {
    const r: CollectionResolution = { needsChainChoice: true, contract: '0xabc', chains: [] };
    expect(isChainChoiceNeeded(r)).toBe(true);
  });

  it('does not narrow a resolved collection', () => {
    const r: CollectionResolution = { contract: '0xabc', chainId: 1, chainName: 'Ethereum', openSeaUrl: null, name: null, image: null, mintedCount: null, maxSupply: null, mintableHere: true };
    expect(isChainChoiceNeeded(r)).toBe(false);
  });
});

describe('fetchCollectionSupply', () => {
  it('reads the per-chain supply route', async () => {
    apiRequestMock.mockResolvedValueOnce({ chainId: 46630, contract: '0xabc', mintedCount: 5, maxSupply: 10, fetchedAt: 1, cached: false });
    const reading = await fetchCollectionSupply(46630, '0xabc');
    expect(apiRequestMock).toHaveBeenCalledWith('/chains/46630/collections/0xabc/supply');
    expect(reading.mintedCount).toBe(5);
  });
});

describe('fetchProxiedImageObjectUrl', () => {
  it('attaches the bearer token and returns an object URL on success', async () => {
    const blob = new Blob(['x']);
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => blob }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake-url'), revokeObjectURL: vi.fn() });

    const url = await fetchProxiedImageObjectUrl('/chains/46630/collections/0xabc/image');

    expect(fetchMock).toHaveBeenCalledWith('/api/chains/46630/collections/0xabc/image', { headers: { Authorization: 'Bearer test-token' } });
    expect(url).toBe('blob:fake-url');
    vi.unstubAllGlobals();
  });

  it('returns null on a non-ok response, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, blob: async () => new Blob() })));
    expect(await fetchProxiedImageObjectUrl('/x')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('returns null when fetch itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network error'); }));
    expect(await fetchProxiedImageObjectUrl('/x')).toBeNull();
    vi.unstubAllGlobals();
  });
});
