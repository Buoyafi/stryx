import { describe, expect, it } from 'vitest';
import { chainById, openSeaChainNameToId, rpcUrlFor, rpcFallbackUrlFor, configuredChainIds, CHAIN_REGISTRY, testnetsSwitchedOff, unrecognizedRpcEnvKeys } from '../src/chain-registry.js';
import type { AppConfig } from '@stryx/config';

// Minimal config stub: only the RPC fields matter for these tests.
function cfg(overrides: Partial<AppConfig>): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: 'postgres://x',
    KMS_PROVIDER: 'local',
    REDIS_URL: 'redis://x',
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('chain registry', () => {
  it('maps OpenSea chain-name "robinhood" to chain id 4663', () => {
    // The correction that started this: Robinhood IS on OpenSea, as "robinhood".
    expect(openSeaChainNameToId('robinhood')).toBe(4663);
  });

  it('maps the major EVM chains by their OpenSea names', () => {
    expect(openSeaChainNameToId('ethereum')).toBe(1);
    expect(openSeaChainNameToId('base')).toBe(8453);
    expect(openSeaChainNameToId('arbitrum')).toBe(42161);
    expect(openSeaChainNameToId('optimism')).toBe(10);
    expect(openSeaChainNameToId('matic')).toBe(137); // OpenSea uses "matic" for Polygon
    expect(openSeaChainNameToId('polygon')).toBe(137); // and newer URLs "polygon"
    expect(openSeaChainNameToId('bera_chain')).toBe(80094);
    expect(openSeaChainNameToId('hyperevm')).toBe(999);
  });

  it('returns null for an unknown OpenSea chain-name', () => {
    expect(openSeaChainNameToId('some-chain-we-dont-know')).toBeNull();
  });

  it('looks up a chain definition by id', () => {
    expect(chainById(8453)?.name).toBe('Base');
    expect(chainById(999999)).toBeUndefined();
  });

  it('resolves an RPC url only when that chain is configured', () => {
    const config = cfg({ RPC_BASE: 'https://base.example.com', RPC_ETHEREUM: undefined });
    expect(rpcUrlFor(config, 8453)).toBe('https://base.example.com');
    expect(rpcUrlFor(config, 1)).toBeUndefined();
  });

  it('configuredChainIds lists exactly the chains with an RPC set', () => {
    const config = cfg({
      RPC_ROBINHOOD_PRIMARY: 'https://rh.example.com',
      RPC_BASE: 'https://base.example.com',
    });
    const ids = configuredChainIds(config).sort((a, b) => a - b);
    expect(ids).toEqual([8453, 4663].sort((a, b) => a - b));
  });

  it('resolves each chain\'s own fallback url, and none where it is unset', () => {
    const config = cfg({ RPC_ROBINHOOD_FALLBACK: 'https://rh-fallback.example.com', RPC_ETHEREUM_FALLBACK: 'https://eth-fallback.example.com' });
    expect(rpcFallbackUrlFor(config, 4663)).toBe('https://rh-fallback.example.com');
    expect(rpcFallbackUrlFor(config, 1)).toBe('https://eth-fallback.example.com');
    expect(rpcFallbackUrlFor(config, 8453)).toBeUndefined();
  });

  it('every chain has a fallback slot named after its main one', () => {
    for (const c of CHAIN_REGISTRY) {
      const base = String(c.rpcEnvKey).replace(/_PRIMARY$/, '');
      expect(c.rpcFallbackEnvKey, c.name).toBe(`${base}_FALLBACK`);
    }
  });

  it('flags RPC_* variables no chain reads, with the name they most likely meant', () => {
    const found = unrecognizedRpcEnvKeys({
      RPC_ETHEREUM_PRIMARY: 'https://eth.example.com',
      RPC_BASE: 'https://base.example.com',
      RPC_ARBITRUM_FALLBACK: 'https://arb.example.com',
      RPC_SOLANA: 'https://sol.example.com',
      RPC_EMPTY_ONE: '',
      NOT_RPC: 'x',
    });
    expect(found).toEqual([
      { key: 'RPC_ETHEREUM_PRIMARY', didYouMean: 'RPC_ETHEREUM' },
      { key: 'RPC_SOLANA', didYouMean: null },
    ]);
  });

  it('a chain with only its fallback set (primary blank) still counts as configured', () => {
    const config = cfg({ RPC_ROBINHOOD_TESTNET_FALLBACK: 'https://rh-testnet-fallback.example.com' });
    expect(rpcUrlFor(config, 46630)).toBeUndefined();
    expect(configuredChainIds(config)).toContain(46630);
  });

  describe('testnets (ENABLE_TESTNETS)', () => {
    const rpcs = { RPC_BASE: 'https://base.example.com', RPC_ROBINHOOD_TESTNET: 'https://rh-testnet.example.com' };

    it('are on by default outside production', () => {
      expect(configuredChainIds(cfg({ ...rpcs, NODE_ENV: 'development' }))).toContain(46630);
      expect(testnetsSwitchedOff(cfg({ ...rpcs, NODE_ENV: 'development' }))).toEqual([]);
    });

    it('are off by default in production even with their RPC set, and reported as switched off', () => {
      const config = cfg({ ...rpcs, NODE_ENV: 'production' });
      expect(configuredChainIds(config)).toEqual([8453]);
      expect(testnetsSwitchedOff(config).map((c) => c.chainId)).toEqual([46630]);
    });

    it('follow ENABLE_TESTNETS when it is set, either way', () => {
      expect(configuredChainIds(cfg({ ...rpcs, NODE_ENV: 'production', ENABLE_TESTNETS: true }))).toContain(46630);
      expect(configuredChainIds(cfg({ ...rpcs, NODE_ENV: 'development', ENABLE_TESTNETS: false }))).toEqual([8453]);
    });
  });

  it('every registry entry has a unique chainId and openSeaChainName', () => {
    const ids = new Set(CHAIN_REGISTRY.map((c) => c.chainId));
    const named = CHAIN_REGISTRY.map((c) => c.openSeaChainName).filter((n) => n !== null);
    expect(ids.size).toBe(CHAIN_REGISTRY.length);
    expect(new Set(named).size).toBe(named.length);
  });
});
