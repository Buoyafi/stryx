import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * Fetches a URL a deployer chose: a contract's `contractURI()` and the `image` its metadata names are
 * attacker-controlled. Only https and ipfs, never a private or local address (checked after DNS
 * resolution too), with a size cap and a timeout.
 */

const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: an IPv4 address in disguise
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/** An IP address that is on the public internet. IPv4 written inside IPv6 (::ffff:127.0.0.1) is judged as the IPv4 it is. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

const PRIVATE_NAMES = new Set(['localhost']);
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp'];

/** The host of a URL as a bare name or address: no brackets, no trailing dot, lower case. */
function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isSafePublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = hostOf(url);
  if (host === '') return false;
  if (isIP(host) !== 0) return isPublicAddress(host);
  if (PRIVATE_NAMES.has(host) || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // A bare name with no dot ("redis", "postgres") only means something on a private network.
  if (!host.includes('.')) return false;
  return true;
}

/** How a host name is turned into addresses. `dns.promises.lookup` with `all: true` fits; tests pass their own. */
export type HostLookup = (host: string) => Promise<ReadonlyArray<{ address: string }>>;
const systemLookup: HostLookup = (host) => dnsLookup(host, { all: true });

/** True when the URL's host is a public address, or a name whose every address is public. */
async function resolvesToPublic(rawUrl: string, lookup: HostLookup): Promise<boolean> {
  const host = hostOf(new URL(rawUrl));
  if (isIP(host) !== 0) return isPublicAddress(host);
  try {
    const addresses = await lookup(host);
    return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}

const MAX_REDIRECTS = 3;

/**
 * `ipfs://<cid>/<path>` and `ipfs://ipfs/<cid>/<path>` (both seen in the wild in NFT metadata)
 * normalised through one public gateway.
 */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export function normalizeIpfsUri(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('ipfs://')) return trimmed;
  const rest = trimmed.slice('ipfs://'.length).replace(/^ipfs\//, '');
  return IPFS_GATEWAY + rest;
}

export interface FetchedBytes {
  contentType: string | null;
  bytes: Uint8Array;
}

/** The subset of a fetch Response this needs. */
export interface RawFetchLike {
  (url: string, init?: { signal?: AbortSignal; redirect?: 'manual' }): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    body: ReadableStream<Uint8Array> | null;
  }>;
}

/**
 * Fetches `raw` (normalising ipfs:// first) with the guards above, and caps bytes read while streaming
 * rather than trusting Content-Length.
 */
export async function safeFetch(
  raw: string,
  opts: { maxBytes: number; timeoutMs: number; fetchImpl?: RawFetchLike; lookup?: HostLookup },
): Promise<FetchedBytes | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as RawFetchLike);
  const lookup = opts.lookup ?? systemLookup;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  const timedOut = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }));
  timedOut.catch(() => undefined);
  try {
    let url = normalizeIpfsUri(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isSafePublicUrl(url)) return null;
      if (!(await Promise.race([resolvesToPublic(url, lookup), timedOut]))) return null;

      // Redirects are not followed for us: each one is a new URL to check.
      const res = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return null;
        try {
          url = new URL(location, url).toString();
        } catch {
          return null;
        }
        continue;
      }
      if (!res.ok || !res.body) return null;

      const contentType = res.headers.get('content-type');
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          controller.abort();
          return null;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { contentType, bytes };
    }
    return null; // too many redirects
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Real image formats only, checked against the bytes, never the Content-Type header alone. */
const SIGNATURES: { type: string; bytes: number[] }[] = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

export function detectImageType(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (bytes.length >= sig.bytes.length && sig.bytes.every((b, i) => bytes[i] === b)) return sig.type;
  }
  // WEBP: 'RIFF' .... 'WEBP', the size field in the middle is irrelevant to type.
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}
