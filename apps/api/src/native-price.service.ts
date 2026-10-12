import { withTimeout } from '@stryx/utils';

/** A chain's native token priced in USD, cached briefly. */
const COINGECKO_ID: Readonly<Record<number, string>> = {
  1: 'ethereum', // Ethereum
  8453: 'ethereum', // Base
  42161: 'ethereum', // Arbitrum One
  10: 'ethereum', // Optimism
  137: 'polygon-ecosystem-token', // Polygon (POL)
  2741: 'ethereum', // Abstract
  57073: 'ethereum', // Ink
  56: 'binancecoin', // BNB Chain (BNB)
  43114: 'avalanche-2', // Avalanche (AVAX)
  999: 'hyperliquid', // HyperEVM (HYPE)
  80094: 'berachain-bera', // Berachain (BERA)
  143: 'monad', // Monad (MON)
  2020: 'ronin', // Ronin (RON)
};

/** Chains whose native token is a dollar stablecoin: priced at exactly $1 without a request. */
const FIXED_USD: Readonly<Record<number, number>> = {
  5042: 1, // Arc (USDC)
};

export interface NativePriceReader {
  /** Returns null when the chain has no price mapping (see COINGECKO_ID above), not an error. */
  getUsdPrice(chainId: number): Promise<number | null>;
}

export interface NativePriceReading {
  chainId: number;
  usdPerToken: number | null;
  fetchedAt: number;
  cached: boolean;
}

export const NATIVE_PRICE_TTL_MS = 60_000;
const NATIVE_PRICE_READ_TIMEOUT_MS = 8_000;

export class NativePriceService {
  private readonly cache = new Map<number, { usdPerToken: number | null; fetchedAt: number }>();
  private readonly inFlight = new Map<number, Promise<{ usdPerToken: number | null; fetchedAt: number }>>();

  constructor(
    private readonly reader: NativePriceReader,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = NATIVE_PRICE_TTL_MS,
  ) {}

  async get(chainId: number): Promise<NativePriceReading> {
    const hit = this.cache.get(chainId);
    if (hit && this.now() - hit.fetchedAt < this.ttlMs) return { chainId, ...hit, cached: true };

    let pending = this.inFlight.get(chainId);
    if (!pending) {
      pending = withTimeout(this.reader.getUsdPrice(chainId), NATIVE_PRICE_READ_TIMEOUT_MS, `native price read (chain ${chainId})`)
        .then((usdPerToken) => {
          const fresh = { usdPerToken, fetchedAt: this.now() };
          this.cache.set(chainId, fresh);
          return fresh;
        })
        .finally(() => this.inFlight.delete(chainId));
      this.inFlight.set(chainId, pending);
    }
    return { chainId, ...(await pending), cached: false };
  }
}

/** The minimal fetch surface this needs: a real global fetch, or a test double, satisfy it directly. */
export type SimpleFetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The CoinGecko id priced for a chain, or null (unmapped, or a fixed-price chain). */
export function coinGeckoIdFor(chainId: number): string | null {
  return FIXED_USD[chainId] !== undefined ? null : (COINGECKO_ID[chainId] ?? null);
}

/** A fixed price (Arc's USDC: $1), or undefined when the chain is priced from the feed. */
export function fixedUsdFor(chainId: number): number | undefined {
  return FIXED_USD[chainId];
}

export type CoinGeckoPriceResult = { ok: true; usd: number } | { ok: false; reason: string };

/**
 * One CoinGecko "simple price" lookup that says why when it fails, so the chain doctor can tell
 * rate-limited from blocked from a wrong id.
 */
export async function fetchCoinGeckoUsd(fetchImpl: SimpleFetchLike, id: string, opts: { apiBase?: string; apiKey?: string | undefined } = {}): Promise<CoinGeckoPriceResult> {
  const apiBase = opts.apiBase ?? 'https://api.coingecko.com';
  try {
    const res = await fetchImpl(`${apiBase}/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`, opts.apiKey ? { headers: { 'x-cg-demo-api-key': opts.apiKey } } : undefined);
    if (!res.ok) {
      const why = res.status === 429 ? 'rate-limited (HTTP 429)' : res.status === 401 || res.status === 403 ? `refused (HTTP ${res.status}): the feed may now need an API key, set COINGECKO_API_KEY` : `HTTP ${res.status}`;
      return { ok: false, reason: why };
    }
    const body = (await res.json()) as Record<string, { usd?: unknown } | undefined>;
    const usd = body[id]?.usd;
    return typeof usd === 'number' && Number.isFinite(usd) ? { ok: true, usd } : { ok: false, reason: `no price for id "${id}" in the response (wrong id?)` };
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}${err.cause instanceof Error ? ` (${err.cause.message})` : ''}` : String(err);
    return { ok: false, reason: `could not reach the price feed: ${msg}` };
  }
}

/** CoinGecko's "simple price" endpoint. */
export function createCoinGeckoNativePriceReader(fetchImpl: SimpleFetchLike, apiBase = 'https://api.coingecko.com', apiKey?: string): NativePriceReader {
  return {
    async getUsdPrice(chainId: number): Promise<number | null> {
      const fixed = fixedUsdFor(chainId);
      if (fixed !== undefined) return fixed;
      const id = coinGeckoIdFor(chainId);
      if (!id) return null;
      const result = await fetchCoinGeckoUsd(fetchImpl, id, { apiBase, apiKey });
      return result.ok ? result.usd : null;
    },
  };
}
