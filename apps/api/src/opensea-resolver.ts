import { withRetry, isFetchTransportFailure, describeFetchFailure } from '@stryx/utils';
import { parseOpenSeaUrl, openSeaChainToId } from './opensea-url.js';

/** What the resolver produces: enough to hand straight to a mint or schedule request. */
export interface ResolvedDrop {
  contract: `0x${string}`;
  chainId: number | null;
  chainName: string;
  slug?: string;
}

export class OpenSeaResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenSeaResolveError';
  }
}

/** The minimal fetch surface the resolver needs. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Turns an OpenSea URL or a bare collection slug into a contract and chain. */
export class OpenSeaResolver {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly apiKey: string | undefined,
    private readonly apiBase = 'https://api.opensea.io',
  ) {}

  async resolve(input: string): Promise<ResolvedDrop> {
    const trimmed = input.trim();

    // A bare slug (no scheme, no dots, no slashes) -> treat as collection slug.
    const looksLikeUrl = /^https?:\/\//i.test(trimmed);
    if (!looksLikeUrl) {
      if (!/^[a-z0-9-]+$/i.test(trimmed)) {
        throw new OpenSeaResolveError(`"${trimmed}" is neither a valid OpenSea URL nor a plausible collection slug.`);
      }
      return this.resolveBySlug(trimmed);
    }

    const parsed = parseOpenSeaUrl(trimmed);
    if (!parsed) {
      throw new OpenSeaResolveError('Could not parse an OpenSea collection or asset URL from that input.');
    }

    if (parsed.kind === 'asset') {
      return {
        contract: parsed.contract,
        chainId: openSeaChainToId(parsed.chainName),
        chainName: parsed.chainName,
      };
    }

    return this.resolveBySlug(parsed.slug);
  }

  private async resolveBySlug(slug: string): Promise<ResolvedDrop> {
    if (!this.apiKey) {
      throw new OpenSeaResolveError(
        'Resolving a collection slug requires an OpenSea API key (OPENSEA_API_KEY). Asset URLs, which contain the contract directly, do not.',
      );
    }

    // A network failure of the fetch itself is turned into a typed error instead of a bare 500.
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await withRetry(
        () => this.fetchImpl(`${this.apiBase}/api/v2/collections/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json', 'x-api-key': this.apiKey! } }),
        { attempts: 4, delayMs: 600, isRetryable: isFetchTransportFailure },
      );
    } catch (err) {
      if (isFetchTransportFailure(err)) {
        throw new OpenSeaResolveError(`Could not reach OpenSea (${describeFetchFailure(err)}, 4 tries). Usually transient: try again in a moment. If it keeps happening, run npm run chains:doctor.`);
      }
      throw err;
    }

    if (!res.ok) {
      throw new OpenSeaResolveError(`OpenSea API returned ${res.status} for collection "${slug}".`);
    }

    const body = (await res.json()) as {
      contracts?: Array<{ address?: string; chain?: string }>;
    };

    const primary = body.contracts?.[0];
    if (!primary?.address || !primary.chain) {
      throw new OpenSeaResolveError(`OpenSea collection "${slug}" has no contract/chain in the API response.`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(primary.address)) {
      throw new OpenSeaResolveError(`OpenSea returned a malformed contract address for "${slug}".`);
    }

    return {
      contract: primary.address as `0x${string}`,
      chainId: openSeaChainToId(primary.chain),
      chainName: primary.chain,
      slug,
    };
  }
}
