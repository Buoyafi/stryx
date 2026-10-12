import { describe, expect, it, vi, beforeEach } from 'vitest';

const safeFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/safe-image-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/safe-image-fetch.js')>()),
  safeFetch: safeFetchMock,
}));

import { CollectionImageService, IMAGE_CACHE_MAX_ENTRIES, IMAGE_RETRY_TTL_MS } from '../src/collection-image.service.js';
import { TimeoutBudgetExceededError } from '@stryx/utils';
import type { ChainServices } from '../src/chain-services.js';

const CONTRACT = '0x1234567890123456789012345678901234567890' as const;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeServices(contractURI: () => Promise<string>): ChainServices {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: { readContract: async () => contractURI() } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seaDropReader: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionEngine: {} as any,
  };
}

beforeEach(() => {
  safeFetchMock.mockReset();
});

describe('CollectionImageService: resolves an image from contract metadata, validated and cached', () => {
  it('reads contractURI, fetches the metadata JSON, then the image it names, and validates the real bytes', async () => {
    safeFetchMock
      .mockImplementationOnce(async () => ({ contentType: 'application/json', bytes: new TextEncoder().encode('{"image":"ipfs://bafy/1.png"}') }))
      .mockImplementationOnce(async () => ({ contentType: 'image/png', bytes: PNG }));

    const chainServices = new Map([[46630, fakeServices(async () => 'ipfs://bafy/metadata.json')]]);
    const service = new CollectionImageService(chainServices);
    const image = await service.get(46630, CONTRACT);

    expect(image?.contentType).toBe('image/png');
    expect([...image!.bytes]).toEqual([...PNG]);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(safeFetchMock.mock.calls[1]![0]).toBe('ipfs://bafy/1.png'); // the metadata's own image field, fetched next
  });

  it('returns null when the contract has no contractURI (the read throws/reverts)', async () => {
    const chainServices = new Map([[46630, fakeServices(async () => { throw new Error('reverted'); })]]);
    const service = new CollectionImageService(chainServices);
    expect(await service.get(46630, CONTRACT)).toBeNull();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('returns null when the metadata JSON has no usable image field', async () => {
    safeFetchMock.mockResolvedValueOnce({ contentType: 'application/json', bytes: new TextEncoder().encode('{"name":"Foo"}') });
    const chainServices = new Map([[46630, fakeServices(async () => 'https://example.com/metadata.json')]]);
    const service = new CollectionImageService(chainServices);
    expect(await service.get(46630, CONTRACT)).toBeNull();
  });

  it('returns null when the metadata is not valid JSON', async () => {
    safeFetchMock.mockResolvedValueOnce({ contentType: 'text/html', bytes: new TextEncoder().encode('<html>not json</html>') });
    const chainServices = new Map([[46630, fakeServices(async () => 'https://example.com/metadata.json')]]);
    const service = new CollectionImageService(chainServices);
    expect(await service.get(46630, CONTRACT)).toBeNull();
  });

  it('returns null when the named image fails validation (e.g. an SVG, rejected by safeFetch/detectImageType)', async () => {
    safeFetchMock
      .mockImplementationOnce(async () => ({ contentType: 'application/json', bytes: new TextEncoder().encode('{"image":"https://example.com/1.svg"}') }))
      .mockImplementationOnce(async () => null); // safeFetch itself already rejects non-image bytes via detectImageType downstream in real code; here the image fetch simply fails
    const chainServices = new Map([[46630, fakeServices(async () => 'https://example.com/metadata.json')]]);
    const service = new CollectionImageService(chainServices);
    expect(await service.get(46630, CONTRACT)).toBeNull();
  });

  it('caches a resolved image: the second call within the TTL does not re-read the chain or re-fetch', async () => {
    safeFetchMock
      .mockImplementationOnce(async () => ({ contentType: 'application/json', bytes: new TextEncoder().encode('{"image":"https://example.com/1.png"}') }))
      .mockImplementationOnce(async () => ({ contentType: 'image/png', bytes: PNG }));
    let reads = 0;
    const chainServices = new Map([[46630, fakeServices(async () => { reads++; return 'https://example.com/metadata.json'; })]]);
    let now = 0;
    const service = new CollectionImageService(chainServices, () => now, 60_000);

    await service.get(46630, CONTRACT);
    now += 1_000;
    await service.get(46630, CONTRACT);

    expect(reads).toBe(1);
    expect(safeFetchMock).toHaveBeenCalledTimes(2); // only from the first resolve
  });

  it('caches a confirmed-absent image too, so a collection with no image is not re-walked every request', async () => {
    let reads = 0;
    const chainServices = new Map([[46630, fakeServices(async () => { reads++; throw new Error('no contractURI'); })]]);
    let now = 0;
    const service = new CollectionImageService(chainServices, () => now, 60_000);

    expect(await service.get(46630, CONTRACT)).toBeNull();
    now += 1_000;
    expect(await service.get(46630, CONTRACT)).toBeNull();

    expect(reads).toBe(1);
  });

  it('re-resolves once the cache entry has expired', async () => {
    let reads = 0;
    const chainServices = new Map([[46630, fakeServices(async () => { reads++; throw new Error('no contractURI'); })]]);
    let now = 0;
    const service = new CollectionImageService(chainServices, () => now, 1_000);

    await service.get(46630, CONTRACT);
    now += 2_000;
    await service.get(46630, CONTRACT);

    expect(reads).toBe(2);
  });

  it('returns null for a chain this instance has no services for', async () => {
    const service = new CollectionImageService(new Map());
    expect(await service.get(46630, CONTRACT)).toBeNull();
  });

  it('concurrent requests for the same chain+contract share one resolution', async () => {
    let reads = 0;
    safeFetchMock
      .mockImplementationOnce(async () => ({ contentType: 'application/json', bytes: new TextEncoder().encode('{"image":"https://example.com/1.png"}') }))
      .mockImplementationOnce(async () => ({ contentType: 'image/png', bytes: PNG }));
    const chainServices = new Map([[46630, fakeServices(async () => { reads++; return 'https://example.com/metadata.json'; })]]);
    const service = new CollectionImageService(chainServices);

    const [a, b] = await Promise.all([service.get(46630, CONTRACT), service.get(46630, CONTRACT)]);
    expect(a?.contentType).toBe('image/png');
    expect(b?.contentType).toBe('image/png');
    expect(reads).toBe(1);
  });

  it('a fetch that failed (slow or down host) is looked at again after a few minutes, not an hour', async () => {
    safeFetchMock.mockResolvedValue(null);
    let reads = 0;
    const chainServices = new Map([[46630, fakeServices(async () => { reads++; return 'https://example.com/metadata.json'; })]]);
    let now = 0;
    const service = new CollectionImageService(chainServices, () => now, 60 * 60_000);

    await service.get(46630, CONTRACT);
    now += IMAGE_RETRY_TTL_MS - 1;
    await service.get(46630, CONTRACT);
    expect(reads).toBe(1);
    now += 2;
    await service.get(46630, CONTRACT);
    expect(reads).toBe(2);
  });

  it('a contractURI read that timed out is not cached as "no image" for the full TTL', async () => {
    let reads = 0;
    const chainServices = new Map([[46630, fakeServices(async () => { reads++; throw new TimeoutBudgetExceededError('contractURI read', 8_000); })]]);
    let now = 0;
    const service = new CollectionImageService(chainServices, () => now, 60 * 60_000);

    await service.get(46630, CONTRACT);
    now += IMAGE_RETRY_TTL_MS + 1;
    await service.get(46630, CONTRACT);
    expect(reads).toBe(2);
  });

  it('holds at most IMAGE_CACHE_MAX_ENTRIES, dropping the oldest', async () => {
    let reads = 0;
    const chainServices = new Map([[46630, fakeServices(async () => { reads++; throw new Error('reverted'); })]]);
    const service = new CollectionImageService(chainServices, () => 0, 60 * 60_000);
    const contract = (i: number) => `0x${i.toString(16).padStart(40, '0')}` as `0x${string}`;

    for (let i = 0; i <= IMAGE_CACHE_MAX_ENTRIES; i++) await service.get(46630, contract(i));
    expect(reads).toBe(IMAGE_CACHE_MAX_ENTRIES + 1);
    await service.get(46630, contract(IMAGE_CACHE_MAX_ENTRIES));
    expect(reads).toBe(IMAGE_CACHE_MAX_ENTRIES + 1);
    await service.get(46630, contract(0));
    expect(reads).toBe(IMAGE_CACHE_MAX_ENTRIES + 2);
  });
});
