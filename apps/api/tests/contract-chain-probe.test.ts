import { describe, expect, it } from 'vitest';
import { probeChainsForContract } from '../src/contract-chain-probe.js';
import type { ChainServices } from '../src/chain-services.js';

const CONTRACT = '0x1234567890123456789012345678901234567890' as const;
const CODE = '0x6001600055' as const;

function fakeServices(getBytecode: (address: string) => Promise<string | undefined>): ChainServices {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: { getBytecode: async ({ address }: { address: string }) => getBytecode(address) } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seaDropReader: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionEngine: {} as any,
  };
}

describe('probeChainsForContract', () => {
  it('reports every configured chain that has code at the address, sorted by chain id', () => {
    const chainServices = new Map<number, ChainServices>([
      [46630, fakeServices(async () => CODE)],
      [4663, fakeServices(async () => undefined)], // no code: not deployed here
      [1, fakeServices(async () => CODE)],
    ]);

    return probeChainsForContract(CONTRACT, chainServices).then((found) => {
      expect(found.map((f) => f.chainId)).toEqual([1, 46630]);
      expect(found.every((f) => typeof f.name === 'string' && f.name.length > 0)).toBe(true);
    });
  });

  it('treats "0x" (viem\'s empty-code sentinel) the same as no code', async () => {
    const chainServices = new Map<number, ChainServices>([[46630, fakeServices(async () => '0x')]]);
    const found = await probeChainsForContract(CONTRACT, chainServices);
    expect(found).toEqual([]);
  });

  it('returns nothing when no configured chain has code there', async () => {
    const chainServices = new Map<number, ChainServices>([
      [46630, fakeServices(async () => undefined)],
      [4663, fakeServices(async () => '0x')],
    ]);
    const found = await probeChainsForContract(CONTRACT, chainServices);
    expect(found).toEqual([]);
  });

  it('an unresponsive chain is excluded, not fatal to the whole probe', async () => {
    const chainServices = new Map<number, ChainServices>([
      [46630, fakeServices(async () => CODE)],
      [1, fakeServices(async () => { throw new Error('RPC down'); })],
    ]);
    const found = await probeChainsForContract(CONTRACT, chainServices);
    expect(found.map((f) => f.chainId)).toEqual([46630]);
  });

  it('returns nothing for an empty chain set', async () => {
    const found = await probeChainsForContract(CONTRACT, new Map());
    expect(found).toEqual([]);
  });
});
