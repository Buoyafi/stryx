import { apiRequest, getToken } from './api';

export interface CollectionImageRef {
  /** `external`: use `url` directly as an <img src> (OpenSea's own CDN). */
  kind: 'external' | 'proxied';
  url: string;
}

export interface ResolvedCollection {
  contract: string;
  chainId: number;
  chainName: string;
  slug?: string;
  openSeaUrl: string | null;
  name: string | null;
  image: CollectionImageRef | null;
  mintedCount: number | null;
  maxSupply: number | null;
  mintableHere: boolean;
  note?: string;
}

export interface ChainChoiceNeeded {
  needsChainChoice: true;
  contract: string;
  chains: { chainId: number; name: string }[];
}

export type CollectionResolution = ResolvedCollection | ChainChoiceNeeded;

export function isChainChoiceNeeded(r: CollectionResolution): r is ChainChoiceNeeded {
  return 'needsChainChoice' in r;
}

/** Paste an OpenSea URL, a slug, or a bare contract address. */
export function resolveCollection(input: string, chainId?: number): Promise<CollectionResolution> {
  return apiRequest<CollectionResolution>('/resolve/collection', { method: 'POST', body: { input, ...(chainId !== undefined ? { chainId } : {}) } });
}

export interface SupplyReading {
  chainId: number;
  contract: string;
  mintedCount: number | null;
  maxSupply: number | null;
  fetchedAt: number;
  cached: boolean;
}

export function fetchCollectionSupply(chainId: number, contract: string): Promise<SupplyReading> {
  return apiRequest<SupplyReading>(`/chains/${chainId}/collections/${contract}/supply`);
}

/** Fetches a proxied collection image as bytes and hands back a blob: URL the caller can drop straight into an <img src>. */
export async function fetchProxiedImageObjectUrl(path: string): Promise<string | null> {
  try {
    const token = getToken();
    const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
