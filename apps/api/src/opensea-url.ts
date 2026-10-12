import { openSeaChainNameToId } from './chain-registry.js';

/** Re-exported from the central chain registry so the resolver and its tests have one import site. */
export function openSeaChainToId(chainName: string): number | null {
  return openSeaChainNameToId(chainName);
}

export type ParsedOpenSeaUrl =
  | { kind: 'collection'; slug: string }
  | { kind: 'asset'; chainName: string; contract: `0x${string}`; tokenId: string };

/**
 * Parses an OpenSea URL into a collection slug (which needs an API lookup) or a direct asset reference
 * (which already has the contract). Pure: no network.
 */
export function parseOpenSeaUrl(raw: string): ParsedOpenSeaUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (!/(^|\.)opensea\.io$/i.test(url.hostname)) {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);

  // /collection/{slug}
  if (segments[0] === 'collection' && segments[1]) {
    return { kind: 'collection', slug: segments[1] };
  }

  // /assets/{chain}/{contract}/{tokenId}
  if (segments[0] === 'assets' && segments[1] && segments[2] && segments[3]) {
    const contract = segments[2];
    if (/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      return { kind: 'asset', chainName: segments[1], contract: contract as `0x${string}`, tokenId: segments[3] };
    }
  }

  return null;
}
