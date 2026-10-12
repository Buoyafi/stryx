import { describe, expect, it } from 'vitest';
import { parseOpenSeaUrl, openSeaChainToId } from '../src/opensea-url.js';
import { OpenSeaResolver, OpenSeaResolveError, type FetchLike } from '../src/opensea-resolver.js';

describe('parseOpenSeaUrl', () => {
  it('parses a collection URL to a slug', () => {
    expect(parseOpenSeaUrl('https://opensea.io/collection/boredapeyachtclub')).toEqual({
      kind: 'collection',
      slug: 'boredapeyachtclub',
    });
  });

  it('parses an asset URL to chain + contract + tokenId', () => {
    const r = parseOpenSeaUrl('https://opensea.io/assets/ethereum/0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D/1');
    expect(r).toEqual({
      kind: 'asset',
      chainName: 'ethereum',
      contract: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
      tokenId: '1',
    });
  });

  it('tolerates query strings and trailing paths', () => {
    expect(parseOpenSeaUrl('https://opensea.io/collection/azuki?tab=activity')).toEqual({
      kind: 'collection',
      slug: 'azuki',
    });
  });

  it('accepts testnets/pro subdomains', () => {
    expect(parseOpenSeaUrl('https://testnets.opensea.io/collection/my-test-drop')?.kind).toBe('collection');
  });

  it('rejects non-opensea hosts', () => {
    expect(parseOpenSeaUrl('https://notopensea.io/collection/x')).toBeNull();
    expect(parseOpenSeaUrl('https://evil.com/opensea.io/collection/x')).toBeNull();
  });

  it('rejects an asset URL with a malformed contract', () => {
    expect(parseOpenSeaUrl('https://opensea.io/assets/ethereum/not-an-address/1')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(parseOpenSeaUrl('not a url')).toBeNull();
    expect(parseOpenSeaUrl('https://opensea.io/')).toBeNull();
  });
});

describe('openSeaChainToId', () => {
  it('maps known chains', () => {
    expect(openSeaChainToId('ethereum')).toBe(1);
    expect(openSeaChainToId('base')).toBe(8453);
  });
  it('returns null for unknown chains', () => {
    expect(openSeaChainToId('some-l2-we-dont-support')).toBeNull();
  });
});

function fakeFetch(response: { ok: boolean; status: number; body: unknown }): FetchLike {
  return async () => ({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  });
}

describe('OpenSeaResolver', () => {
  it('resolves an asset URL with no API call and no API key', async () => {
    // fetch that throws if called: proves the asset path never hits the network.
    const resolver = new OpenSeaResolver(
      (() => {
        throw new Error('fetch should not be called for asset URLs');
      }) as unknown as FetchLike,
      undefined,
    );

    const r = await resolver.resolve('https://opensea.io/assets/base/0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D/7');
    expect(r.contract).toBe('0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D');
    expect(r.chainId).toBe(8453);
    expect(r.chainName).toBe('base');
  });

  it('resolves a collection slug via the API', async () => {
    const resolver = new OpenSeaResolver(
      fakeFetch({
        ok: true,
        status: 200,
        body: { contracts: [{ address: '0x1234567890123456789012345678901234567890', chain: 'ethereum' }] },
      }),
      'test-key',
    );

    const r = await resolver.resolve('https://opensea.io/collection/some-drop');
    expect(r.contract).toBe('0x1234567890123456789012345678901234567890');
    expect(r.chainId).toBe(1);
    expect(r.slug).toBe('some-drop');
  });

  it('resolves a bare slug (no URL) via the API', async () => {
    const resolver = new OpenSeaResolver(
      fakeFetch({
        ok: true,
        status: 200,
        body: { contracts: [{ address: '0x1234567890123456789012345678901234567890', chain: 'base' }] },
      }),
      'test-key',
    );

    const r = await resolver.resolve('boredapeyachtclub');
    expect(r.chainId).toBe(8453);
  });

  it('reports chainId null for a resolved chain the platform does not support', async () => {
    const resolver = new OpenSeaResolver(
      fakeFetch({
        ok: true,
        status: 200,
        body: { contracts: [{ address: '0x1234567890123456789012345678901234567890', chain: 'zora' }] },
      }),
      'test-key',
    );

    const r = await resolver.resolve('https://opensea.io/collection/zora-drop');
    expect(r.chainId).toBeNull();
    expect(r.chainName).toBe('zora');
  });

  it('throws a clear error resolving a slug with no API key', async () => {
    const resolver = new OpenSeaResolver(fakeFetch({ ok: true, status: 200, body: {} }), undefined);
    await expect(resolver.resolve('https://opensea.io/collection/x')).rejects.toThrow(OpenSeaResolveError);
  });

  it('throws on an API error status', async () => {
    const resolver = new OpenSeaResolver(fakeFetch({ ok: false, status: 404, body: {} }), 'test-key');
    await expect(resolver.resolve('https://opensea.io/collection/missing')).rejects.toThrow(/404/);
  });

  it('throws on a non-opensea URL', async () => {
    const resolver = new OpenSeaResolver(fakeFetch({ ok: true, status: 200, body: {} }), 'test-key');
    await expect(resolver.resolve('https://example.com/foo')).rejects.toThrow(OpenSeaResolveError);
  });
});

describe('OpenSeaResolver: a raw network-transport failure (Node fetch throwing, not an HTTP error response)', () => {
  it('retries once and succeeds, rather than failing on the first transient failure', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return { ok: true, status: 200, json: async () => ({ contracts: [{ address: '0x1234567890123456789012345678901234567890', chain: 'ethereum' }] }) };
    };
    const resolver = new OpenSeaResolver(fetchImpl, 'test-key');

    const r = await resolver.resolve('some-drop');
    expect(r.contract).toBe('0x1234567890123456789012345678901234567890');
    expect(calls).toBe(2);
  });

  it('throws a typed OpenSeaResolveError, not a raw TypeError, once retries are exhausted (this used to reach the caller as a bare 500)', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const resolver = new OpenSeaResolver(fetchImpl, 'test-key');

    await expect(resolver.resolve('some-drop')).rejects.toBeInstanceOf(OpenSeaResolveError);
    await expect(resolver.resolve('some-drop')).rejects.toThrow(/transient/i);
  });

  it('does not retry a real HTTP error response (only a raw transport failure)', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    };
    const resolver = new OpenSeaResolver(fetchImpl, 'test-key');

    await expect(resolver.resolve('some-drop')).rejects.toThrow(/429/);
    expect(calls).toBe(1);
  });

  it('does not retry, and rethrows unchanged, a non-transport error (e.g. a bug in the fetch implementation itself)', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('something unrelated broke');
    };
    const resolver = new OpenSeaResolver(fetchImpl, 'test-key');
    await expect(resolver.resolve('some-drop')).rejects.toThrow('something unrelated broke');
  });
});
