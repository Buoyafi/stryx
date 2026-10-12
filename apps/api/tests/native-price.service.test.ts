import { describe, expect, it } from 'vitest';
import { NativePriceService, createCoinGeckoNativePriceReader, fetchCoinGeckoUsd, type SimpleFetchLike } from '../src/native-price.service.js';

describe('createCoinGeckoNativePriceReader', () => {
  it('maps Ethereum, Base, Arbitrum and Optimism all to the real ethereum price', async () => {
    const requested: string[] = [];
    const fetchImpl: SimpleFetchLike = async (url) => {
      requested.push(url);
      return { ok: true, status: 200, json: async () => ({ ethereum: { usd: 2738.82 } }) };
    };
    const reader = createCoinGeckoNativePriceReader(fetchImpl);
    for (const chainId of [1, 8453, 42161, 10]) {
      expect(await reader.getUsdPrice(chainId)).toBe(2738.82);
    }
    expect(requested.every((u) => u.includes('ids=ethereum'))).toBe(true);
  });

  it('maps Polygon to POL (polygon-ecosystem-token), not legacy MATIC', async () => {
    let requestedUrl = '';
    const fetchImpl: SimpleFetchLike = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, json: async () => ({ 'polygon-ecosystem-token': { usd: 0.108051 } }) };
    };
    const reader = createCoinGeckoNativePriceReader(fetchImpl);
    expect(await reader.getUsdPrice(137)).toBe(0.108051);
    expect(requestedUrl).toContain('ids=polygon-ecosystem-token');
    expect(requestedUrl).not.toContain('matic-network');
  });

  it('phase B chains: each asks for its own token, Abstract and Ink for ethereum', async () => {
    const requested: string[] = [];
    const fetchImpl: SimpleFetchLike = async (url) => {
      requested.push(url);
      const id = new URL(url).searchParams.get('ids')!;
      return { ok: true, status: 200, json: async () => ({ [id]: { usd: 7 } }) };
    };
    const reader = createCoinGeckoNativePriceReader(fetchImpl);
    const expected: Record<number, string> = { 56: 'binancecoin', 43114: 'avalanche-2', 999: 'hyperliquid', 80094: 'berachain-bera', 143: 'monad', 2020: 'ronin', 2741: 'ethereum', 57073: 'ethereum' };
    for (const [chainId, id] of Object.entries(expected)) {
      requested.length = 0;
      expect(await reader.getUsdPrice(Number(chainId))).toBe(7);
      expect(requested[0], chainId).toContain(`ids=${id}`);
    }
  });

  it('Arc (native USDC) is exactly $1 without a request', async () => {
    let called = false;
    const reader = createCoinGeckoNativePriceReader(async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    });
    expect(await reader.getUsdPrice(5042)).toBe(1);
    expect(called).toBe(false);
  });

  it('returns null for Robinhood Chain and its testnet WITHOUT making a request: their "ETH" is not really Ethereum', async () => {
    let called = false;
    const fetchImpl: SimpleFetchLike = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const reader = createCoinGeckoNativePriceReader(fetchImpl);
    expect(await reader.getUsdPrice(4663)).toBeNull();
    expect(await reader.getUsdPrice(46630)).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null (not a throw) for an unrecognised chainId', async () => {
    const reader = createCoinGeckoNativePriceReader(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    expect(await reader.getUsdPrice(999999)).toBeNull();
  });

  it('returns null on a non-2xx response', async () => {
    const reader = createCoinGeckoNativePriceReader(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    expect(await reader.getUsdPrice(1)).toBeNull();
  });

  it('returns null when the response has no usd field for the requested id', async () => {
    const reader = createCoinGeckoNativePriceReader(async () => ({ ok: true, status: 200, json: async () => ({ ethereum: {} }) }));
    expect(await reader.getUsdPrice(1)).toBeNull();
  });

  it('returns null rather than throwing when fetch itself throws', async () => {
    const reader = createCoinGeckoNativePriceReader(async () => {
      throw new Error('network error');
    });
    expect(await reader.getUsdPrice(1)).toBeNull();
  });
});

describe('NativePriceService', () => {
  it('caches within the TTL and refreshes once it expires', async () => {
    let reads = 0;
    const reader = { getUsdPrice: async () => { reads++; return 100 * reads; } };
    let now = 0;
    const service = new NativePriceService(reader, () => now, 1_000);

    const first = await service.get(1);
    expect(first).toMatchObject({ chainId: 1, usdPerToken: 100, cached: false });

    now += 500;
    const second = await service.get(1);
    expect(second).toMatchObject({ usdPerToken: 100, cached: true });

    now += 600;
    const third = await service.get(1);
    expect(third).toMatchObject({ usdPerToken: 200, cached: false });

    expect(reads).toBe(2);
  });

  it('caches a null (unmapped chain) reading too: it is a stable, correct answer, not a failure to retry', async () => {
    let reads = 0;
    const reader = { getUsdPrice: async () => { reads++; return null; } };
    const service = new NativePriceService(reader, () => 0, 60_000);
    await service.get(4663);
    await service.get(4663);
    expect(reads).toBe(1);
  });

  it('concurrent requests for the same chain share one read', async () => {
    let reads = 0;
    const reader = { getUsdPrice: async () => { reads++; return 1; } };
    const service = new NativePriceService(reader);
    await Promise.all([service.get(1), service.get(1)]);
    expect(reads).toBe(1);
  });
});

describe('fetchCoinGeckoUsd: says why a price is missing', () => {
  const res = (status: number, body: unknown = {}) => async () => ({ ok: status < 300, status, json: async () => body });
  it('names a rate limit, a refusal, a wrong id and a network failure', async () => {
    expect(await fetchCoinGeckoUsd(res(429), 'ethereum')).toEqual({ ok: false, reason: 'rate-limited (HTTP 429)' });
    expect((await fetchCoinGeckoUsd(res(401), 'ethereum')) as { reason: string }).toMatchObject({ ok: false, reason: expect.stringMatching(/COINGECKO_API_KEY/) });
    expect(await fetchCoinGeckoUsd(res(200, {}), 'nope')).toEqual({ ok: false, reason: 'no price for id "nope" in the response (wrong id?)' });
    const down = async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT') });
    };
    expect(await fetchCoinGeckoUsd(down, 'ethereum')).toEqual({ ok: false, reason: 'could not reach the price feed: fetch failed (connect ETIMEDOUT)' });
  });

  it('sends the demo key header when a key is set', async () => {
    let headers: Record<string, string> | undefined;
    await fetchCoinGeckoUsd(async (_url, init) => {
      headers = init?.headers;
      return { ok: true, status: 200, json: async () => ({ ethereum: { usd: 1 } }) };
    }, 'ethereum', { apiKey: 'CG-abc' });
    expect(headers).toEqual({ 'x-cg-demo-api-key': 'CG-abc' });
  });
});
