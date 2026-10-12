import { describe, expect, it } from 'vitest';
import { detectImageType, isPublicAddress, isSafePublicUrl, normalizeIpfsUri, safeFetch, type HostLookup, type RawFetchLike } from '../src/safe-image-fetch.js';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const GIF_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const SVG_TEXT = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function streamOf(chunks: number[][]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      controller.enqueue(new Uint8Array(chunks[i]!));
      i++;
    },
  });
}

/** Every name resolves to one public address, so no test touches real DNS. */
const publicLookup: HostLookup = async () => [{ address: '93.184.216.34' }];

function fakeFetch(status: number, contentType: string | null, body: number[] | null): RawFetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    body: body === null ? null : streamOf([body]),
  });
}

describe('detectImageType: real bytes only, never the content-type header', () => {
  it('recognises PNG, JPEG, GIF and WEBP by their magic numbers', () => {
    expect(detectImageType(new Uint8Array(PNG_HEADER))).toBe('image/png');
    expect(detectImageType(new Uint8Array(JPEG_HEADER))).toBe('image/jpeg');
    expect(detectImageType(new Uint8Array(GIF_HEADER))).toBe('image/gif');
    expect(detectImageType(new Uint8Array(WEBP_HEADER))).toBe('image/webp');
  });

  it('rejects SVG: no binary magic number, so it never matches, whatever the file claims to be', () => {
    expect(detectImageType(SVG_TEXT)).toBeNull();
  });

  it('rejects HTML, plain text and empty bytes', () => {
    expect(detectImageType(new TextEncoder().encode('<html></html>'))).toBeNull();
    expect(detectImageType(new TextEncoder().encode('not an image'))).toBeNull();
    expect(detectImageType(new Uint8Array(0))).toBeNull();
  });
});

describe('isSafePublicUrl', () => {
  it('accepts a plain public https URL', () => {
    expect(isSafePublicUrl('https://ipfs.io/ipfs/bafybeigd/1.png')).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isSafePublicUrl('file:///etc/passwd')).toBe(false);
    expect(isSafePublicUrl('ftp://example.com/x')).toBe(false);
    expect(isSafePublicUrl('data:image/png;base64,AAAA')).toBe(false);
  });

  it('rejects loopback and private IPv4 ranges', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0']) {
      expect(isSafePublicUrl(`http://${host}/x`)).toBe(false);
    }
  });

  it('does not reject a public IPv4 that merely starts with a private octet', () => {
    // 172.32.x.x and 172.15.x.x are outside the private 172.16.0.0/12 range.
    expect(isSafePublicUrl('http://172.32.0.1/x')).toBe(true);
    expect(isSafePublicUrl('http://172.15.0.1/x')).toBe(true);
  });

  it('rejects localhost and .local hostnames', () => {
    expect(isSafePublicUrl('http://localhost/x')).toBe(false);
    expect(isSafePublicUrl('http://printer.local/x')).toBe(false);
  });

  it('rejects malformed URLs rather than throwing', () => {
    expect(isSafePublicUrl('not a url')).toBe(false);
  });

  it('rejects private IPv6 addresses, which a URL writes in brackets', () => {
    for (const host of ['[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[ff02::1]']) {
      expect(isSafePublicUrl(`http://${host}/x`)).toBe(false);
    }
    expect(isSafePublicUrl('http://[2606:4700:4700::1111]/x')).toBe(true);
  });

  it('rejects an IPv4 address written inside an IPv6 one', () => {
    for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:169.254.169.254]', '[::ffff:10.0.0.1]', '[64:ff9b::7f00:1]']) {
      expect(isSafePublicUrl(`http://${host}/x`)).toBe(false);
    }
  });

  it('rejects the number forms a URL turns into a private IPv4 address', () => {
    for (const host of ['2130706433', '0x7f.1', '0177.0.0.1', '127.1']) {
      expect(isSafePublicUrl(`http://${host}/x`)).toBe(false);
    }
  });

  it('rejects the cloud metadata address, carrier NAT and multicast', () => {
    for (const host of ['169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1']) {
      expect(isSafePublicUrl(`http://${host}/x`)).toBe(false);
    }
  });

  it('rejects localhost with a trailing dot, names under it, and bare one-word names', () => {
    for (const host of ['localhost.', 'LOCALHOST', 'api.localhost', 'db.internal', 'redis', 'postgres']) {
      expect(isSafePublicUrl(`http://${host}/x`)).toBe(false);
    }
  });
});

describe('isPublicAddress', () => {
  it('knows public from private in both families', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('10.1.2.3')).toBe(false);
    expect(isPublicAddress('::ffff:192.168.0.1')).toBe(false);
    expect(isPublicAddress('not an address')).toBe(false);
  });
});

describe('normalizeIpfsUri', () => {
  it('converts ipfs://<cid>/<path> to the gateway URL', () => {
    expect(normalizeIpfsUri('ipfs://bafybeigd/1.png')).toBe('https://ipfs.io/ipfs/bafybeigd/1.png');
  });

  it('tolerates the ipfs://ipfs/<cid> variant', () => {
    expect(normalizeIpfsUri('ipfs://ipfs/bafybeigd/1.png')).toBe('https://ipfs.io/ipfs/bafybeigd/1.png');
  });

  it('leaves an already-http(s) URL unchanged', () => {
    expect(normalizeIpfsUri('https://example.com/1.png')).toBe('https://example.com/1.png');
  });
});

describe('safeFetch', () => {
  it('fetches and returns bytes plus content-type on success', async () => {
    const result = await safeFetch('https://example.com/1.png', {
      maxBytes: 1_000_000,
      timeoutMs: 5_000,
      lookup: publicLookup,
      fetchImpl: fakeFetch(200, 'image/png', PNG_HEADER),
    });
    expect(result?.contentType).toBe('image/png');
    expect([...result!.bytes]).toEqual(PNG_HEADER);
  });

  it('normalises ipfs:// before fetching', async () => {
    let requested = '';
    const fetchImpl: RawFetchLike = async (url) => {
      requested = url;
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, body: streamOf([PNG_HEADER]) };
    };
    await safeFetch('ipfs://bafybeigd/1.png', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup: publicLookup, fetchImpl });
    expect(requested).toBe('https://ipfs.io/ipfs/bafybeigd/1.png');
  });

  it('refuses to fetch a private/loopback URL: the guard runs before any network call', async () => {
    let called = false;
    const fetchImpl: RawFetchLike = async () => {
      called = true;
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, body: streamOf([PNG_HEADER]) };
    };
    const result = await safeFetch('http://127.0.0.1/x', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup: publicLookup, fetchImpl });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null on a non-2xx response', async () => {
    const result = await safeFetch('https://example.com/404', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup: publicLookup, fetchImpl: fakeFetch(404, 'image/png', PNG_HEADER) });
    expect(result).toBeNull();
  });

  it('returns null when the body is missing', async () => {
    const result = await safeFetch('https://example.com/empty', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup: publicLookup, fetchImpl: fakeFetch(200, 'image/png', null) });
    expect(result).toBeNull();
  });

  it('aborts and returns null once more bytes than the cap have actually been received, not trusting Content-Length', async () => {
    const bigChunk = new Array(1000).fill(0xff);
    const fetchImpl: RawFetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n === 'content-length' ? '10' : 'image/png') }, // lies: claims tiny, sends much more
      body: streamOf([bigChunk, bigChunk, bigChunk]),
    });
    const result = await safeFetch('https://example.com/huge.png', { maxBytes: 500, timeoutMs: 5_000, lookup: publicLookup, fetchImpl });
    expect(result).toBeNull();
  });

  it('refuses a public-looking name that resolves to a private address, before any request', async () => {
    let called = false;
    const fetchImpl: RawFetchLike = async () => {
      called = true;
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, body: streamOf([PNG_HEADER]) };
    };
    for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.8', '::1', '::ffff:10.0.0.8']) {
      const lookup: HostLookup = async () => [{ address }];
      expect(await safeFetch('https://images.example.com/1.png', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup, fetchImpl })).toBeNull();
    }
    expect(called).toBe(false);
  });

  it('refuses a name with one public and one private address', async () => {
    const lookup: HostLookup = async () => [{ address: '93.184.216.34' }, { address: '192.168.1.10' }];
    const result = await safeFetch('https://images.example.com/1.png', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup, fetchImpl: fakeFetch(200, 'image/png', PNG_HEADER) });
    expect(result).toBeNull();
  });

  it('refuses a name that does not resolve', async () => {
    const lookup: HostLookup = async () => {
      throw new Error('ENOTFOUND');
    };
    const result = await safeFetch('https://nowhere.example.com/1.png', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup, fetchImpl: fakeFetch(200, 'image/png', PNG_HEADER) });
    expect(result).toBeNull();
  });

  function redirectingFetch(hops: Record<string, string>, seen: string[]): RawFetchLike {
    return async (url, init) => {
      seen.push(url);
      expect(init?.redirect).toBe('manual');
      const location = hops[url];
      if (location !== undefined) {
        return { ok: false, status: 302, headers: { get: (n: string) => (n.toLowerCase() === 'location' ? location : null) }, body: null };
      }
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, body: streamOf([PNG_HEADER]) };
    };
  }

  it('follows a redirect to another public address', async () => {
    const seen: string[] = [];
    const fetchImpl = redirectingFetch({ 'https://example.com/1.png': '/real/1.png' }, seen);
    const result = await safeFetch('https://example.com/1.png', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup: publicLookup, fetchImpl });
    expect([...result!.bytes]).toEqual(PNG_HEADER);
    expect(seen).toEqual(['https://example.com/1.png', 'https://example.com/real/1.png']);
  });

  it('does not follow a redirect to a private address', async () => {
    for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]:6379/', 'http://localhost:3000/admin', 'file:///etc/passwd']) {
      const seen: string[] = [];
      const fetchImpl = redirectingFetch({ 'https://example.com/1.png': target }, seen);
      const result = await safeFetch('https://example.com/1.png', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup: publicLookup, fetchImpl });
      expect(result).toBeNull();
      expect(seen).toEqual(['https://example.com/1.png']);
    }
  });

  it('does not follow a redirect to a name that resolves to a private address', async () => {
    const seen: string[] = [];
    const fetchImpl = redirectingFetch({ 'https://example.com/1.png': 'https://inside.example.net/1.png' }, seen);
    const lookup: HostLookup = async (host) => [{ address: host === 'inside.example.net' ? '10.0.0.8' : '93.184.216.34' }];
    const result = await safeFetch('https://example.com/1.png', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup, fetchImpl });
    expect(result).toBeNull();
    expect(seen).toEqual(['https://example.com/1.png']);
  });

  it('gives up after three redirects', async () => {
    const seen: string[] = [];
    const hops: Record<string, string> = {};
    for (let i = 0; i < 10; i++) hops[`https://example.com/${i}`] = `https://example.com/${i + 1}`;
    const result = await safeFetch('https://example.com/0', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup: publicLookup, fetchImpl: redirectingFetch(hops, seen) });
    expect(result).toBeNull();
    expect(seen).toHaveLength(4);
  });

  it('gives up when the name lookup outlasts the time limit', async () => {
    const lookup: HostLookup = () => new Promise(() => undefined);
    const result = await safeFetch('https://slow.example.com/1.png', { maxBytes: 1_000_000, timeoutMs: 30, lookup, fetchImpl: fakeFetch(200, 'image/png', PNG_HEADER) });
    expect(result).toBeNull();
  });

  it('returns null on a thrown/aborted fetch rather than propagating', async () => {
    const fetchImpl: RawFetchLike = async () => {
      throw new Error('network error');
    };
    const result = await safeFetch('https://example.com/x', { maxBytes: 1_000_000, timeoutMs: 5_000, lookup: publicLookup, fetchImpl });
    expect(result).toBeNull();
  });
});
