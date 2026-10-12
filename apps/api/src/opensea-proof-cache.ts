import type { OpenSeaAllowListData, OpenSeaProofFetcher } from './opensea-drop-client.js';
import { OpenSeaDropError } from './opensea-drop-client.js';

/** How long a fetched OpenSea allow-list lookup is reused. */
const TTL_MS = 30_000;

interface CacheEntry {
  expiresAt: number;
  result: { ok: true; data: OpenSeaAllowListData } | { ok: false; error: OpenSeaDropError };
}

/**
 * Wraps an `OpenSeaProofFetcher` with a short-lived cache keyed by `slug:address`, without the
 * quantity: the proof and mintParams do not depend on it. Failures are never cached.
 */
export class CachingOpenSeaDropClient implements OpenSeaProofFetcher {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly inner: OpenSeaProofFetcher,
    private readonly ttlMs = TTL_MS,
  ) {}

  async fetchAllowListData(slug: string, minter: `0x${string}`, quantity: number): Promise<OpenSeaAllowListData> {
    const key = `${slug}:${minter.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.result.ok) return cached.result.data;
      throw cached.result.error;
    }

    try {
      const data = await this.inner.fetchAllowListData(slug, minter, quantity);
      this.cache.set(key, { expiresAt: Date.now() + this.ttlMs, result: { ok: true, data } });
      return data;
    } catch (err) {
      if (err instanceof OpenSeaDropError && err.code === 'not_found') {
        this.cache.set(key, { expiresAt: Date.now() + this.ttlMs, result: { ok: false, error: err } });
      }
      throw err;
    }
  }
}
