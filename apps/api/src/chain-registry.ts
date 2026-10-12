import { CHAINS, type Chain, type KnownChainId } from '@stryx/chains';
import { testnetsEnabled, type AppConfig } from '@stryx/config';

/**
 * Every chain this platform knows, as the API sees it: the shared chain table (@stryx/chains) plus the
 * one thing that is deployment config, the RPC URL.
 */
export interface ChainDefinition extends Chain {
  rpcEnvKey: keyof AppConfig;
  /** The env var for this chain's optional second provider (see rpc-client-factory.ts). */
  rpcFallbackEnvKey: keyof AppConfig;
}

// Record<KnownChainId, ...> makes a chain added to @stryx/chains without an entry here a type error.
const RPC_ENV_KEYS: Record<KnownChainId, keyof AppConfig> = {
  4663: 'RPC_ROBINHOOD_PRIMARY',
  46630: 'RPC_ROBINHOOD_TESTNET',
  1: 'RPC_ETHEREUM',
  8453: 'RPC_BASE',
  42161: 'RPC_ARBITRUM',
  10: 'RPC_OPTIMISM',
  137: 'RPC_POLYGON',
  56: 'RPC_BNB',
  999: 'RPC_HYPEREVM',
  80094: 'RPC_BERACHAIN',
  143: 'RPC_MONAD',
  43114: 'RPC_AVALANCHE',
  2741: 'RPC_ABSTRACT',
  57073: 'RPC_INK',
  2020: 'RPC_RONIN',
  5042: 'RPC_ARC',
};

/** Every chain has a fallback slot, so a second provider can be added for any of them from .env alone. */
const RPC_FALLBACK_ENV_KEYS: Record<KnownChainId, keyof AppConfig> = {
  4663: 'RPC_ROBINHOOD_FALLBACK',
  46630: 'RPC_ROBINHOOD_TESTNET_FALLBACK',
  1: 'RPC_ETHEREUM_FALLBACK',
  8453: 'RPC_BASE_FALLBACK',
  42161: 'RPC_ARBITRUM_FALLBACK',
  10: 'RPC_OPTIMISM_FALLBACK',
  137: 'RPC_POLYGON_FALLBACK',
  56: 'RPC_BNB_FALLBACK',
  999: 'RPC_HYPEREVM_FALLBACK',
  80094: 'RPC_BERACHAIN_FALLBACK',
  143: 'RPC_MONAD_FALLBACK',
  43114: 'RPC_AVALANCHE_FALLBACK',
  2741: 'RPC_ABSTRACT_FALLBACK',
  57073: 'RPC_INK_FALLBACK',
  2020: 'RPC_RONIN_FALLBACK',
  5042: 'RPC_ARC_FALLBACK',
};

/** `RPC_*` variables in the environment that no chain reads, such as a misspelt name. */
export function unrecognizedRpcEnvKeys(env: Record<string, string | undefined>): Array<{ key: string; didYouMean: string | null }> {
  const known = new Set<string>([...Object.values(RPC_ENV_KEYS), ...Object.values(RPC_FALLBACK_ENV_KEYS)]);
  return Object.keys(env)
    .filter((k) => k.startsWith('RPC_') && !known.has(k) && (env[k] ?? '').trim() !== '')
    .sort()
    .map((key) => {
      const stripped = key.replace(/_(PRIMARY|MAIN|MAINNET|URL|HTTP|HTTPS)$/, '');
      const guess = [...known].find((k) => k === stripped) ?? null;
      return { key, didYouMean: guess };
    });
}

export const CHAIN_REGISTRY: readonly ChainDefinition[] = CHAINS.map((chain) => ({
  ...chain,
  rpcEnvKey: RPC_ENV_KEYS[chain.chainId],
  rpcFallbackEnvKey: RPC_FALLBACK_ENV_KEYS[chain.chainId],
}));

const BY_ID = new Map(CHAIN_REGISTRY.map((c) => [c.chainId, c]));
/** OpenSea's name for each chain, plus any aliases its URLs use; chains OpenSea does not support have none. */
const BY_OPENSEA_NAME = new Map(
  CHAIN_REGISTRY.flatMap((c) => [...(c.openSeaChainName ? [c.openSeaChainName] : []), ...('openSeaAliases' in c ? (c.openSeaAliases ?? []) : [])].map((n) => [n, c] as const)),
);

export function chainById(chainId: number): ChainDefinition | undefined {
  return BY_ID.get(chainId);
}

/** Maps an OpenSea chain-name string to a numeric chain id, or null if unknown. */
export function openSeaChainNameToId(chainName: string): number | null {
  return BY_OPENSEA_NAME.get(chainName.toLowerCase())?.chainId ?? null;
}

/** The RPC URL configured for a chain, or undefined if not set. */
export function rpcUrlFor(config: AppConfig, chainId: number): string | undefined {
  const def = BY_ID.get(chainId);
  if (!def) return undefined;
  const value = config[def.rpcEnvKey];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The fallback RPC URL configured for a chain, or undefined if this chain has no fallback env var at all, or it's unset. */
export function rpcFallbackUrlFor(config: AppConfig, chainId: number): string | undefined {
  const def = BY_ID.get(chainId);
  if (!def) return undefined;
  const value = config[def.rpcFallbackEnvKey];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Every chainId with an actually-configured RPC URL right now (primary, fallback, or both), testnets only when switched on. */
export function configuredChainIds(config: AppConfig): number[] {
  const testnets = testnetsEnabled(config);
  return CHAIN_REGISTRY.filter((c) => (testnets || !c.isTestnet) && (rpcUrlFor(config, c.chainId) !== undefined || rpcFallbackUrlFor(config, c.chainId) !== undefined)).map((c) => c.chainId);
}

/** Testnets whose RPC is set but which are switched off (see ENABLE_TESTNETS): logged at startup so it is never a mystery. */
export function testnetsSwitchedOff(config: AppConfig): ChainDefinition[] {
  if (testnetsEnabled(config)) return [];
  return CHAIN_REGISTRY.filter((c) => c.isTestnet && (rpcUrlFor(config, c.chainId) !== undefined || rpcFallbackUrlFor(config, c.chainId) !== undefined));
}
