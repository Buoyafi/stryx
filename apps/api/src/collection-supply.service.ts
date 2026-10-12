import { withTimeout } from '@stryx/utils';
import type { ChainServices } from './chain-services.js';

/** Short TTL, concurrent reads share one in-flight call, a failure is never cached. */
export const SUPPLY_TTL_MS = 10_000;
/** Above the RPC transport's own worst case (2 attempts of 5s), so a retry about to succeed is never cut off. */
const SUPPLY_READ_TIMEOUT_MS = 12_000;

export interface SupplyReading {
  chainId: number;
  contract: `0x${string}`;
  mintedCount: number | null;
  maxSupply: number | null;
  fetchedAt: number;
  cached: boolean;
}

export class CollectionSupplyService {
  private readonly cache = new Map<string, { mintedCount: number | null; maxSupply: number | null; fetchedAt: number }>();
  private readonly inFlight = new Map<string, Promise<{ mintedCount: number | null; maxSupply: number | null; fetchedAt: number }>>();

  constructor(
    private readonly chainServices: ReadonlyMap<number, ChainServices>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SUPPLY_TTL_MS,
  ) {}

  async get(chainId: number, contract: `0x${string}`): Promise<SupplyReading> {
    const key = `${chainId}:${contract.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.fetchedAt < this.ttlMs) return { chainId, contract, ...hit, cached: true };

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.read(chainId, contract)
        .then((fresh) => {
          this.cache.set(key, fresh);
          return fresh;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return { chainId, contract, ...(await pending), cached: false };
  }

  private async read(chainId: number, contract: `0x${string}`): Promise<{ mintedCount: number | null; maxSupply: number | null; fetchedAt: number }> {
    const services = this.chainServices.get(chainId);
    if (!services) throw new Error(`no chain services for chainId=${chainId}`);
    const stats = await withTimeout(
      services.seaDropReader.getMintStats({ nftContract: contract, chainId }, '0x0000000000000000000000000000000000000000'),
      SUPPLY_READ_TIMEOUT_MS,
      `mint stats read (chain ${chainId})`,
    );
    return { mintedCount: Number(stats.currentTotalSupply), maxSupply: Number(stats.maxSupply), fetchedAt: this.now() };
  }
}
