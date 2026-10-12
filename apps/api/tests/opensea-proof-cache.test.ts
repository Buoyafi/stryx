import { describe, expect, it, vi } from 'vitest';
import { CachingOpenSeaDropClient } from '../src/opensea-proof-cache.js';
import { OpenSeaDropError, type OpenSeaAllowListData, type OpenSeaProofFetcher } from '../src/opensea-drop-client.js';

const DATA: OpenSeaAllowListData = {
  mintParams: {
    mintPrice: 0n,
    maxTotalMintableByWallet: 10,
    startTime: 1_700_000_000,
    endTime: 2_000_000_000,
    dropStageIndex: 1,
    maxTokenSupplyForStage: 1000n,
    feeBps: 0,
    restrictFeeRecipients: false,
  },
  proof: [('0x' + 'ab'.repeat(32)) as `0x${string}`],
};

const ADDR_A = '0x0000000000000000000000000000000000000A' as `0x${string}`;
const ADDR_B = '0x0000000000000000000000000000000000000B' as `0x${string}`;

function fakeFetcher(behavior: (slug: string, minter: `0x${string}`) => Promise<OpenSeaAllowListData>): OpenSeaProofFetcher & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async fetchAllowListData(slug, minter) {
      calls++;
      return behavior(slug, minter);
    },
  };
}

describe('CachingOpenSeaDropClient', () => {
  it('serves a second call for the SAME (slug, address) from cache: one real fetch, not two', async () => {
    const inner = fakeFetcher(async () => DATA);
    const client = new CachingOpenSeaDropClient(inner);

    const first = await client.fetchAllowListData('drop-1', ADDR_A, 1);
    const second = await client.fetchAllowListData('drop-1', ADDR_A, 1);

    expect(first).toEqual(DATA);
    expect(second).toEqual(DATA);
    expect(inner.calls).toBe(1);
  });

  it('does NOT key on quantity: a different requested quantity for the same wallet still hits the cache', async () => {
    const inner = fakeFetcher(async () => DATA);
    const client = new CachingOpenSeaDropClient(inner);

    await client.fetchAllowListData('drop-1', ADDR_A, 1);
    await client.fetchAllowListData('drop-1', ADDR_A, 5); // different quantity, same wallet

    expect(inner.calls).toBe(1);
  });

  it('treats address case-insensitively, matching how the rest of the codebase compares addresses', async () => {
    const inner = fakeFetcher(async () => DATA);
    const client = new CachingOpenSeaDropClient(inner);

    await client.fetchAllowListData('drop-1', ADDR_A, 1);
    await client.fetchAllowListData('drop-1', (ADDR_A.toLowerCase()) as `0x${string}`, 1);

    expect(inner.calls).toBe(1);
  });

  it('does NOT share a cache entry across different wallets or different slugs', async () => {
    const inner = fakeFetcher(async () => DATA);
    const client = new CachingOpenSeaDropClient(inner);

    await client.fetchAllowListData('drop-1', ADDR_A, 1);
    await client.fetchAllowListData('drop-1', ADDR_B, 1); // different wallet
    await client.fetchAllowListData('drop-2', ADDR_A, 1); // different slug

    expect(inner.calls).toBe(3);
  });

  it('remembers "no such drop", which does not change from one call to the next', async () => {
    const err = new OpenSeaDropError('not_found', 'no drop for that slug');
    const inner = fakeFetcher(async () => {
      throw err;
    });
    const client = new CachingOpenSeaDropClient(inner);

    const first = await client.fetchAllowListData('drop-1', ADDR_A, 1).catch((e: unknown) => e);
    const second = await client.fetchAllowListData('drop-1', ADDR_A, 1).catch((e: unknown) => e);

    expect(first).toBe(err);
    expect(second).toBe(err);
    expect(inner.calls).toBe(1);
  });

  it('never remembers an answer that can change by the next call: an outage, a 429, not active, not eligible, no funds', async () => {
    for (const code of ['network_unavailable', 'bad_response', 'not_active', 'not_eligible', 'insufficient_funds'] as const) {
      let call = 0;
      const inner = fakeFetcher(async () => {
        if (call++ === 0) throw new OpenSeaDropError(code, 'first answer');
        return DATA;
      });
      const client = new CachingOpenSeaDropClient(inner);

      await client.fetchAllowListData('drop-1', ADDR_A, 5).catch(() => undefined);
      // The stage opened, OpenSea came back, the wallet was funded: the next ask gets the real answer.
      expect(await client.fetchAllowListData('drop-1', ADDR_A, 1), code).toEqual(DATA);
      expect(inner.calls, code).toBe(2);
    }
  });

  it('does NOT cache a plain (non-OpenSeaDropError) failure: a transient network blip is retried, not remembered', async () => {
    let call = 0;
    const inner = fakeFetcher(async () => {
      call++;
      if (call === 1) throw new Error('network blip');
      return DATA;
    });
    const client = new CachingOpenSeaDropClient(inner);

    const first = await client.fetchAllowListData('drop-1', ADDR_A, 1).catch((e: unknown) => e);
    const second = await client.fetchAllowListData('drop-1', ADDR_A, 1);

    expect(first).toBeInstanceOf(Error);
    expect(second).toEqual(DATA);
    expect(inner.calls).toBe(2);
  });

  it('re-fetches once the TTL has expired', async () => {
    vi.useFakeTimers();
    try {
      const inner = fakeFetcher(async () => DATA);
      const client = new CachingOpenSeaDropClient(inner, 30_000);

      await client.fetchAllowListData('drop-1', ADDR_A, 1);
      vi.advanceTimersByTime(30_001);
      await client.fetchAllowListData('drop-1', ADDR_A, 1);

      expect(inner.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
