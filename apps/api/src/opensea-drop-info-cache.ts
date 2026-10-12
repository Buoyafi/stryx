import type { DropInfoResult, OpenSeaDropInfo } from './opensea-drop-info.js';

/** What the mint page is told about OpenSea's side of a drop: fresh, stale, not listed, or unavailable. */
export type OpenSeaDropStatus = 'ok' | 'stale' | 'not_listed' | 'unavailable';

export interface DropInfoReading {
  info: OpenSeaDropInfo | null;
  openSea: OpenSeaDropStatus;
  /** When `info` was fetched, for a `stale` reading. */
  asOf?: number;
}

/** A last good answer is served for this long while OpenSea keeps failing. Stages rarely change within it. */
const DEFAULT_STALE_TTL_MS = 30 * 60_000;

/**
 * Remembers each drop's last good OpenSea answer in memory, so a failed refresh keeps its phases on
 * screen (marked stale) instead of dropping them.
 */
export class OpenSeaDropInfoCache {
  private readonly lastGood = new Map<string, { info: OpenSeaDropInfo; at: number }>();

  constructor(
    private readonly load: (chainId: number, contract: string) => Promise<DropInfoResult>,
    private readonly now: () => number = Date.now,
    private readonly staleTtlMs = DEFAULT_STALE_TTL_MS,
  ) {}

  async get(chainId: number, contract: string): Promise<DropInfoReading> {
    const key = `${chainId}:${contract.toLowerCase()}`;
    const result = await this.load(chainId, contract).catch((err: unknown): DropInfoResult => ({ status: 'unavailable', detail: String(err) }));
    if (result.status === 'ok') {
      this.lastGood.set(key, { info: result.info, at: this.now() });
      return { info: result.info, openSea: 'ok' };
    }
    if (result.status === 'not_listed') return { info: null, openSea: 'not_listed' };
    const cached = this.lastGood.get(key);
    if (cached && this.now() - cached.at <= this.staleTtlMs) return { info: cached.info, openSea: 'stale', asOf: cached.at };
    return { info: null, openSea: 'unavailable' };
  }
}
