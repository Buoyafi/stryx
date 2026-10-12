import { withTimeout } from '@stryx/utils';

/** Reads a chain's current gas price, cached per chain for a few seconds. */
export interface GasPriceReader {
  getGasPrice(chainId: number): Promise<bigint>;
}

export interface GasPriceReading {
  chainId: number;
  gasPriceWei: bigint;
  /** Unix ms the price was read from the chain (not when it was served). */
  fetchedAt: number;
  cached: boolean;
}

export const GAS_PRICE_TTL_MS = 10_000;
export const GAS_PRICE_READ_TIMEOUT_MS = 8_000;

export class GasPriceService {
  private readonly cache = new Map<number, { gasPriceWei: bigint; fetchedAt: number }>();
  private readonly inFlight = new Map<number, Promise<{ gasPriceWei: bigint; fetchedAt: number }>>();

  constructor(
    private readonly reader: GasPriceReader,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = GAS_PRICE_TTL_MS,
  ) {}

  async get(chainId: number): Promise<GasPriceReading> {
    const hit = this.cache.get(chainId);
    if (hit && this.now() - hit.fetchedAt < this.ttlMs) return { chainId, ...hit, cached: true };

    let pending = this.inFlight.get(chainId);
    if (!pending) {
      pending = withTimeout(this.reader.getGasPrice(chainId), GAS_PRICE_READ_TIMEOUT_MS, `gas price read (chain ${chainId})`)
        .then((gasPriceWei) => {
          const fresh = { gasPriceWei, fetchedAt: this.now() };
          this.cache.set(chainId, fresh);
          return fresh;
        })
        .finally(() => this.inFlight.delete(chainId));
      this.inFlight.set(chainId, pending);
    }
    return { chainId, ...(await pending), cached: false };
  }
}
