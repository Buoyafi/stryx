import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAINS, chainById, explorerTxUrl, networkLabel } from '../src/index.js';

const packageRoot = join(import.meta.dirname, '..');

describe('chain registry data', () => {
  it('has unique chain ids and unique OpenSea chain names', () => {
    expect(new Set(CHAINS.map((c) => c.chainId)).size).toBe(CHAINS.length);
    const named = CHAINS.map((c) => c.openSeaChainName).filter((n) => n !== null);
    expect(new Set(named).size).toBe(named.length);
  });

  it('gives every chain a gas token with a symbol and 18 decimals', () => {
    for (const c of CHAINS) {
      expect(c.nativeCurrency.symbol.length, c.name).toBeGreaterThan(0);
      expect(c.nativeCurrency.decimals, c.name).toBe(18);
    }
  });

  it('uses the verified gas tokens: POL on Polygon, ETH on the rest', () => {
    expect(chainById(137)?.nativeCurrency.symbol).toBe('POL');
    for (const id of [1, 10, 8453, 42161, 4663, 46630]) expect(chainById(id)?.nativeCurrency.symbol, String(id)).toBe('ETH');
  });

  it('marks exactly the Robinhood testnet as a testnet', () => {
    expect(CHAINS.filter((c) => c.isTestnet).map((c) => c.chainId)).toEqual([46630]);
    expect(networkLabel(chainById(46630)!)).toBe('Testnet');
    expect(networkLabel(chainById(4663)!)).toBe('Mainnet');
  });

  it('has every testnet reuse the icon of a mainnet entry', () => {
    const mainnetIcons = new Set(CHAINS.filter((c) => !c.isTestnet).map((c) => c.icon));
    for (const t of CHAINS.filter((c) => c.isTestnet)) expect(mainnetIcons.has(t.icon), t.name).toBe(true);
  });
});

describe('chain icons', () => {
  const icons = [...new Set(CHAINS.map((c) => c.icon).filter((i): i is NonNullable<typeof i> => i !== null))];

  it('points every icon at a committed file', () => {
    for (const icon of icons) expect(existsSync(join(packageRoot, icon)), icon).toBe(true);
  });

  it('commits only self-contained SVGs: no script, no external reference other than the namespace', () => {
    for (const icon of icons) {
      const svg = readFileSync(join(packageRoot, icon), 'utf8');
      expect(svg.trimStart().startsWith('<svg'), icon).toBe(true);
      expect(svg, icon).not.toMatch(/<script|<image|<foreignObject|@import|xlink:href/i);
      const urls = svg.match(/https?:\/\/[^"'\s)]+/g) ?? [];
      expect(urls.every((u) => u === 'http://www.w3.org/2000/svg'), icon).toBe(true);
    }
  });
});

describe('explorer links', () => {
  const hash = `0x${'ab'.repeat(32)}`;

  it('gives every chain an https explorer with no trailing slash', () => {
    for (const c of CHAINS) {
      expect(c.explorerUrl, c.name).toMatch(/^https:\/\/[^/]+$/);
    }
  });

  it('uses the explorers from Robinhood\'s docs for its two chains', () => {
    expect(chainById(4663)?.explorerUrl).toBe('https://robinhoodchain.blockscout.com');
    expect(chainById(46630)?.explorerUrl).toBe('https://explorer.testnet.chain.robinhood.com');
  });

  it('builds a /tx/ link for a valid hash', () => {
    expect(explorerTxUrl(chainById(8453)!, hash)).toBe(`https://basescan.org/tx/${hash}`);
  });

  it('builds no link for a chain without an explorer, or for something that is not a hash', () => {
    expect(explorerTxUrl({ explorerUrl: null }, hash)).toBeUndefined();
    expect(explorerTxUrl(chainById(1)!, '0x1234')).toBeUndefined();
    expect(explorerTxUrl(chainById(1)!, `${hash}zz`)).toBeUndefined();
    expect(explorerTxUrl(chainById(1)!, 'javascript:alert(1)')).toBeUndefined();
  });
});

describe('disperse contract data', () => {
  it('lists the contract only where it was verified on-chain: six chains, never either Robinhood chain', () => {
    const withContract = CHAINS.filter((c) => c.disperseContract).map((c) => c.chainId).sort((a, b) => a - b);
    expect(withContract).toEqual([1, 10, 56, 137, 8453, 42161]);
    expect(chainById(4663)?.disperseContract).toBeNull();
    expect(chainById(46630)?.disperseContract).toBeNull();
  });

  it('has a well-formed address and a 32-byte lowercase code hash for every listed contract', () => {
    for (const c of CHAINS) {
      if (!c.disperseContract) continue;
      expect(c.disperseContract.address, c.name).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(c.disperseContract.codeHash, c.name).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('pins the two verified bytecodes to the right chains', () => {
    const hashOf = (id: number) => chainById(id)?.disperseContract?.codeHash;
    expect(hashOf(1)).toBe(hashOf(137)); // Ethereum and Polygon
    expect(hashOf(8453)).toBe(hashOf(42161));
    expect(hashOf(8453)).toBe(hashOf(10)); // Base, Arbitrum One and Optimism
    expect(hashOf(1)).not.toBe(hashOf(8453));
  });

  it('fee market: a tip setting only where the tip orders transactions; Polygon enforces a 25 gwei floor', () => {
    const tipped = CHAINS.filter((c) => c.feeMarket.tipAffectsOrdering).map((c) => c.chainId).sort((a, b) => a - b);
    expect(tipped).toEqual([1, 10, 56, 137, 143, 8453, 43114, 57073, 80094]);
    expect(chainById(42161)?.feeMarket.tipAffectsOrdering).toBe(false);
    expect(chainById(4663)?.feeMarket.tipAffectsOrdering).toBe(false);
    expect(chainById(137)?.feeMarket.minPriorityFeeGwei).toBe(25);
    expect(CHAINS.filter((c) => c.feeMarket.minPriorityFeeGwei !== null).map((c) => c.chainId)).toEqual([137, 56]);
  });

  it('phase B chains: verified ids, gas tokens, explorers, OpenSea names', () => {
    const expected: Array<[number, string, string, string | null, string]> = [
      [56, 'BNB Chain', 'BNB', null, 'https://bscscan.com'],
      [999, 'HyperEVM', 'HYPE', 'hyperevm', 'https://hyperevmscan.io'],
      [80094, 'Berachain', 'BERA', 'bera_chain', 'https://berascan.com'],
      [143, 'Monad', 'MON', 'monad', 'https://monadscan.com'],
      [43114, 'Avalanche', 'AVAX', 'avalanche', 'https://snowtrace.io'],
      [2741, 'Abstract', 'ETH', 'abstract', 'https://abscan.org'],
      [57073, 'Ink', 'ETH', null, 'https://explorer.inkonchain.com'],
      [2020, 'Ronin', 'RON', 'ronin', 'https://app.roninchain.com'],
      [5042, 'Arc', 'USDC', null, 'https://arc-scan.io'],
    ];
    for (const [id, name, symbol, os, explorer] of expected) {
      const c = chainById(id);
      expect(c, name).toBeDefined();
      expect([c!.name, c!.nativeCurrency.symbol, c!.openSeaChainName, c!.explorerUrl], name).toEqual([name, symbol, os, explorer]);
      if (id === 56) expect(c!.disperseContract?.codeHash, name).toBe(chainById(1)!.disperseContract!.codeHash); // doctor-verified
      else expect(c!.disperseContract, name).toBeNull(); // none found on-chain
    }
  });

  it('Arc counts its native USDC with 18 decimals and never calls it ETH', () => {
    expect(chainById(5042)?.nativeCurrency).toEqual({ name: 'USD Coin', symbol: 'USDC', decimals: 18 });
  });

  it('fee markets of the new chains: BNB 0.05 gwei floor, Monad charges the gas limit, unverified ones show no tip', () => {
    expect(chainById(56)?.feeMarket).toEqual({ tipAffectsOrdering: true, minPriorityFeeGwei: 0.05, chargesGasLimit: false });
    expect(chainById(143)?.feeMarket.chargesGasLimit).toBe(true);
    expect(CHAINS.filter((c) => c.feeMarket.chargesGasLimit).map((c) => c.chainId)).toEqual([143]);
    for (const id of [999, 2020, 5042, 2741]) expect(chainById(id)?.feeMarket.tipAffectsOrdering, String(id)).toBe(false);
  });
});
