import { isRpcTransportFailure, withTimeout } from '@stryx/utils';
import type { ChainServices } from './chain-services.js';
import { detectImageType, safeFetch, type FetchedBytes } from './safe-image-fetch.js';

/** `contractURI()`: a de facto standard that returns a URI to the collection's metadata JSON. */
const CONTRACT_URI_ABI = [
  { type: 'function', name: 'contractURI', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const CONTRACT_READ_TIMEOUT_MS = 8_000;
const METADATA_MAX_BYTES = 512 * 1024;
const METADATA_TIMEOUT_MS = 8_000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;

export interface ResolvedImage {
  contentType: string;
  bytes: Uint8Array;
}

/** How long a resolved (or confirmed-absent) image is cached, keyed by chain+contract. */
export const IMAGE_CACHE_TTL_MS = 60 * 60 * 1000;
/** A failure that may pass (slow host, RPC trouble) is looked at again sooner than a real "none". */
export const IMAGE_RETRY_TTL_MS = 5 * 60 * 1000;
/** Images are up to 5 MB each: the oldest entry goes once this many are held. */
export const IMAGE_CACHE_MAX_ENTRIES = 200;

type Resolved = { image: ResolvedImage | null; transient?: true };
const transient: Resolved = { image: null, transient: true };
const none: Resolved = { image: null };

/** Resolves a collection's image from contract data, not OpenSea: for an unlisted or testnet collection it is the only source. */
export class CollectionImageService {
  private readonly cache = new Map<string, { image: ResolvedImage | null; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<ResolvedImage | null>>();

  constructor(
    private readonly chainServices: ReadonlyMap<number, ChainServices>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = IMAGE_CACHE_TTL_MS,
  ) {}

  async get(chainId: number, contract: `0x${string}`): Promise<ResolvedImage | null> {
    const key = `${chainId}:${contract.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && this.now() < hit.expiresAt) return hit.image;

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.resolve(chainId, contract)
        .then((resolved) => {
          this.cache.delete(key);
          this.cache.set(key, { image: resolved.image, expiresAt: this.now() + (resolved.transient ? Math.min(IMAGE_RETRY_TTL_MS, this.ttlMs) : this.ttlMs) });
          if (this.cache.size > IMAGE_CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
          return resolved.image;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private async resolve(chainId: number, contract: `0x${string}`): Promise<Resolved> {
    const services = this.chainServices.get(chainId);
    if (!services) return none;

    let uri: string;
    try {
      uri = await withTimeout(
        services.publicClient.readContract({ address: contract, abi: CONTRACT_URI_ABI, functionName: 'contractURI', args: [] }),
        CONTRACT_READ_TIMEOUT_MS,
        `contractURI read (chain ${chainId})`,
      );
    } catch (err) {
      // A revert means the contract has no contractURI: nothing to show. A timeout or a down node says nothing.
      return isRpcTransportFailure(err) ? transient : none;
    }
    if (typeof uri !== 'string' || uri.trim() === '') return none;

    // safeFetch does not say why it failed (slow, down, refused): treated as one that may pass.
    const metadataFetch = await safeFetch(uri, { maxBytes: METADATA_MAX_BYTES, timeoutMs: METADATA_TIMEOUT_MS });
    if (!metadataFetch) return transient;

    let imageField: unknown;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(metadataFetch.bytes)) as Record<string, unknown>;
      imageField = parsed['image'];
    } catch {
      return none;
    }
    if (typeof imageField !== 'string' || imageField.trim() === '') return none;

    return this.fetchAndValidateImage(imageField);
  }

  private async fetchAndValidateImage(imageUri: string): Promise<Resolved> {
    const fetched: FetchedBytes | null = await safeFetch(imageUri, { maxBytes: IMAGE_MAX_BYTES, timeoutMs: IMAGE_TIMEOUT_MS });
    if (!fetched) return transient;
    const contentType = detectImageType(fetched.bytes);
    if (!contentType) return none; // includes SVG, and anything else that isn't a real raster image: no match, no fallback guess
    return { image: { contentType, bytes: fetched.bytes } };
  }
}
