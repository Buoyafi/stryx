import { describe, expect, it } from 'vitest';
import { fetchOpenSeaDropInfo } from '../src/opensea-drop-info.js';
import type { FetchLike } from '../src/opensea-resolver.js';

function fakeFetch(responses: Record<string, { ok: boolean; status: number; body: unknown }>): FetchLike {
  return (async (url: string) => {
    for (const [path, response] of Object.entries(responses)) {
      if (url.includes(path)) return { ok: response.ok, status: response.status, json: async () => response.body };
    }
    throw new Error(`unexpected URL in test: ${url}`);
  }) as unknown as FetchLike;
}

describe('fetchOpenSeaDropInfo', () => {
  it('resolves the contract to a slug, then fetches that slug\'s drop detail: the two real calls verified live against OpenSea\'s API', async () => {
    const fetchImpl = fakeFetch({
      '/chain/ethereum/contract/0xabc': { ok: true, status: 200, body: { collection: 'facetsart' } },
      '/drops/facetsart': {
        ok: true,
        status: 200,
        body: {
          collection_name: 'Facets',
          image_url: 'https://i2c.seadn.io/img.png',
          opensea_url: 'https://opensea.io/collection/facetsart',
          total_supply: '805',
          max_supply: '4269',
          stages: [{ uuid: '81597e3d-1649-437e-8fba-56eb46284b91', stage_type: 'public_sale', label: 'Public Stage', price: '1700000000000000', start_time: '2026-09-16T19:30:00Z', end_time: '2026-10-16T19:30:00Z', max_per_wallet: '69', allowlist_wallet_count: null }],
        },
      },
    });

    const info = await fetchOpenSeaDropInfo(fetchImpl, 'key', 'ethereum', '0xabc');

    expect(info).toEqual({
      collectionSlug: 'facetsart',
      collectionName: 'Facets',
      imageUrl: 'https://i2c.seadn.io/img.png',
      openSeaUrl: 'https://opensea.io/collection/facetsart',
      totalSupply: 805,
      maxSupply: 4269,
      stages: [
        { stageType: 'public_sale', label: 'Public Stage', priceWei: '1700000000000000', startTime: '2026-09-16T19:30:00Z', endTime: '2026-10-16T19:30:00Z', maxPerWallet: 69, allowlistWalletCount: null, uuid: '81597e3d-1649-437e-8fba-56eb46284b91' },
      ],
    });
  });

  it('keeps the ERC-20 a stage is priced in, and leaves it off for the native token', async () => {
    const fetchImpl = fakeFetch({
      '/chain/ethereum/contract/0xabc': { ok: true, status: 200, body: { collection: 'tokenpriced' } },
      '/drops/tokenpriced': {
        ok: true,
        status: 200,
        body: {
          collection_name: 'T',
          stages: [
            { stage_type: 'public_sale', price: '5000000', price_currency_address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
            { stage_type: 'presale', price: '1', price_currency_address: '0x0000000000000000000000000000000000000000' },
          ],
        },
      },
    });

    const info = await fetchOpenSeaDropInfo(fetchImpl, 'key', 'ethereum', '0xabc');

    expect(info?.stages[0]?.priceToken).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(info?.stages[1]).not.toHaveProperty('priceToken');
  });

  it('returns null without an API key, never calling fetch at all', async () => {
    const info = await fetchOpenSeaDropInfo(
      (() => {
        throw new Error('should not be called');
      }) as unknown as FetchLike,
      undefined,
      'ethereum',
      '0xabc',
    );
    expect(info).toBeNull();
  });

  it('returns null (a testnet OpenSea does not recognize, verified live: robinhood_testnet -> "Unrecognized chain") rather than throwing', async () => {
    const fetchImpl = fakeFetch({ '/chain/robinhood_testnet/contract/0xabc': { ok: false, status: 400, body: { errors: ['Unrecognized chain: robinhood_testnet'] } } });

    const info = await fetchOpenSeaDropInfo(fetchImpl, 'key', 'robinhood_testnet', '0xabc');
    expect(info).toBeNull();
  });

  it('returns null when the contract resolves to a slug but that slug has no drop (a listed collection that isn\'t a SeaDrop drop)', async () => {
    const fetchImpl = fakeFetch({
      '/chain/ethereum/contract/0xabc': { ok: true, status: 200, body: { collection: 'some-erc721' } },
      '/drops/some-erc721': { ok: false, status: 404, body: { errors: ['not a drop'] } },
    });

    const info = await fetchOpenSeaDropInfo(fetchImpl, 'key', 'ethereum', '0xabc');
    expect(info).toBeNull();
  });

  it('returns null (never throws) if the network call itself fails, even after retrying', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as FetchLike;

    const info = await fetchOpenSeaDropInfo(fetchImpl, 'key', 'ethereum', '0xabc');
    expect(info).toBeNull();
  });

  it('retries a transient transport failure once, rather than immediately collapsing to null (this used to make a real multi-phase drop look like it had only one phase, the on-chain public stage)', async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('/chain/ethereum/contract/0xabc')) {
        calls++;
        if (calls === 1) throw new TypeError('fetch failed'); // the exact shape isFetchTransportFailure recognizes
        return { ok: true, status: 200, json: async () => ({ collection: 'facetsart' }) };
      }
      if (url.includes('/drops/facetsart')) {
        return { ok: true, status: 200, json: async () => ({ collection_name: 'Facets', stages: [] }) };
      }
      throw new Error(`unexpected URL in test: ${url}`);
    }) as unknown as FetchLike;

    const info = await fetchOpenSeaDropInfo(fetchImpl, 'key', 'ethereum', '0xabc');

    expect(calls).toBe(2); // failed once, succeeded on retry
    expect(info?.collectionName).toBe('Facets'); // NOT null: the retry recovered it
  });

  it('returns null for a malformed response missing the one required field (collection_name), rather than a half-populated object', async () => {
    const fetchImpl = fakeFetch({
      '/chain/ethereum/contract/0xabc': { ok: true, status: 200, body: { collection: 'facetsart' } },
      '/drops/facetsart': { ok: true, status: 200, body: { image_url: 'https://x' } },
    });

    const info = await fetchOpenSeaDropInfo(fetchImpl, 'key', 'ethereum', '0xabc');
    expect(info).toBeNull();
  });
});
