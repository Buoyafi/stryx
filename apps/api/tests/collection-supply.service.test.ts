import { describe, expect, it } from 'vitest';
import { CollectionSupplyService } from '../src/collection-supply.service.js';
import type { ChainServices } from '../src/chain-services.js';

const CONTRACT = '0x1234567890123456789012345678901234567890' as const;

function fakeServices(getMintStats: () => Promise<{ minterNumMinted: number; currentTotalSupply: bigint; maxSupply: bigint }>): ChainServices {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seaDropReader: { getMintStats } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionEngine: {} as any,
  };
}

describe('CollectionSupplyService', () => {
  it('reads minted/max supply from the chain, narrowed to number', async () => {
    const chainServices = new Map([[46630, fakeServices(async () => ({ minterNumMinted: 0, currentTotalSupply: 42n, maxSupply: 1000n }))]]);
    const service = new CollectionSupplyService(chainServices);
    const reading = await service.get(46630, CONTRACT);
    expect(reading).toMatchObject({ chainId: 46630, contract: CONTRACT, mintedCount: 42, maxSupply: 1000, cached: false });
  });

  it('passes the zero address as minter: minterNumMinted is discarded, only the collection totals are used', async () => {
    let seenMinter: string | undefined;
    const chainServices = new Map([
      [
        46630,
        {
          seaDropReader: {
            getMintStats: async (_scope: unknown, minter: string) => {
              seenMinter = minter;
              return { minterNumMinted: 999, currentTotalSupply: 1n, maxSupply: 2n };
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          publicClient: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transactionEngine: {} as any,
        },
      ],
    ]);
    const service = new CollectionSupplyService(chainServices);
    await service.get(46630, CONTRACT);
    expect(seenMinter).toBe('0x0000000000000000000000000000000000000000');
  });

  it('caches within the TTL and refreshes once it expires', async () => {
    let reads = 0;
    const chainServices = new Map([[46630, fakeServices(async () => { reads++; return { minterNumMinted: 0, currentTotalSupply: BigInt(reads), maxSupply: 100n }; })]]);
    let now = 0;
    const service = new CollectionSupplyService(chainServices, () => now, 1_000);

    const first = await service.get(46630, CONTRACT);
    expect(first.cached).toBe(false);
    expect(first.mintedCount).toBe(1);

    now += 500;
    const second = await service.get(46630, CONTRACT);
    expect(second.cached).toBe(true);
    expect(second.mintedCount).toBe(1); // still the cached value, not a fresh read

    now += 600;
    const third = await service.get(46630, CONTRACT);
    expect(third.cached).toBe(false);
    expect(third.mintedCount).toBe(2);

    expect(reads).toBe(2);
  });

  it('rejects for a chain this instance has no services for', async () => {
    const service = new CollectionSupplyService(new Map());
    await expect(service.get(46630, CONTRACT)).rejects.toThrow(/no chain services/);
  });

  it('concurrent requests for the same chain+contract share one read', async () => {
    let reads = 0;
    const chainServices = new Map([[46630, fakeServices(async () => { reads++; return { minterNumMinted: 0, currentTotalSupply: 1n, maxSupply: 2n }; })]]);
    const service = new CollectionSupplyService(chainServices);
    await Promise.all([service.get(46630, CONTRACT), service.get(46630, CONTRACT)]);
    expect(reads).toBe(1);
  });

  it('a failed read is never cached: the next call tries again', async () => {
    let attempt = 0;
    const chainServices = new Map([
      [
        46630,
        fakeServices(async () => {
          attempt++;
          if (attempt === 1) throw new Error('rpc down');
          return { minterNumMinted: 0, currentTotalSupply: 5n, maxSupply: 10n };
        }),
      ],
    ]);
    const service = new CollectionSupplyService(chainServices);
    await expect(service.get(46630, CONTRACT)).rejects.toThrow('rpc down');
    const reading = await service.get(46630, CONTRACT);
    expect(reading.mintedCount).toBe(5);
  });
});
