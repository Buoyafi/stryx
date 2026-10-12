import { describe, expect, it } from 'vitest';
import { redactUrls, redactUrlsKeepDomain, redactUrlsDeep, redactUrlsInKeys, REDACTED_URL } from '../src/redact-urls.js';

describe('redactUrls', () => {
  it('replaces a URL and keeps the rest of the message', () => {
    expect(redactUrls('The request took too long to respond.\n\nURL: https://rpc.provider.io/v2/SECRETKEY123\nVersion: viem@2')).toBe(
      'The request took too long to respond.\n\nURL: [url]\nVersion: viem@2',
    );
  });

  it('removes a key wherever it sits in the URL: path, query, or credentials', () => {
    for (const url of ['https://rpc.io/v2/KEY', 'https://rpc.io/?apikey=KEY', 'https://user:KEY@rpc.io/x', 'https://KEY.rpc.io/x#frag']) {
      expect(redactUrls(`failed calling ${url} today`), url).toBe('failed calling [url] today');
    }
  });

  it('is not limited to http: websocket, redis and database URLs are secrets too', () => {
    expect(redactUrls('wss://rpc.io/ws/KEY')).toBe(REDACTED_URL);
    expect(redactUrls('connect redis://:hunter2@cache.internal:6379 failed')).toBe('connect [url] failed');
    expect(redactUrls('postgres://app:pw@db.internal/stryx refused')).toBe('[url] refused');
  });

  it('handles several URLs, and URLs inside brackets or quotes, without eating the punctuation', () => {
    expect(redactUrls('a https://x.io/1 b (https://y.io/2) c "https://z.io/3" d')).toBe('a [url] b ([url]) c "[url]" d');
  });

  it('is case-insensitive about the scheme', () => {
    expect(redactUrls('HTTPS://RPC.IO/KEY')).toBe(REDACTED_URL);
  });

  it('leaves text with no URL exactly as it is', () => {
    for (const text of ['Simulation reverted: PayerNotAllowed', 'chainId=46630 has no RPC configured', 'ratio 3:1 at 12:30', '']) {
      expect(redactUrls(text)).toBe(text);
    }
  });
});

describe('redactUrlsDeep', () => {
  it('redacts every string in nested objects and arrays, without mutating the input', () => {
    const input = { message: 'see https://a.io/K', results: [{ error: 'x https://b.io/K' }, 7, null, true], n: 1 };
    const out = redactUrlsDeep(input);
    expect(out).toEqual({ message: 'see [url]', results: [{ error: 'x [url]' }, 7, null, true], n: 1 });
    expect(input.message).toBe('see https://a.io/K');
  });

  it('passes non-string primitives and class instances through untouched', () => {
    const date = new Date(0);
    expect(redactUrlsDeep(5)).toBe(5);
    expect(redactUrlsDeep(null)).toBeNull();
    expect(redactUrlsDeep(date)).toBe(date);
  });
});

describe('redactUrlsInKeys', () => {
  const keys = new Set(['error', 'message']);

  it('redacts only the named keys, so legitimate URL fields in the same body survive', () => {
    const body = { openSeaUrl: 'https://opensea.io/collection/x', imageUrl: 'https://img.io/a.png', results: [{ error: 'rpc https://rpc.io/KEY failed', status: 'failed' }] };
    expect(redactUrlsInKeys(body, keys)).toEqual({
      openSeaUrl: 'https://opensea.io/collection/x',
      imageUrl: 'https://img.io/a.png',
      results: [{ error: 'rpc [url] failed', status: 'failed' }],
    });
  });

  it('ignores a named key whose value is not a string', () => {
    expect(redactUrlsInKeys({ error: { nested: 'https://x.io' } }, keys)).toEqual({ error: { nested: 'https://x.io' } });
  });
});

describe('redactUrlsKeepDomain', () => {
  it('keeps the domain and nothing else, wherever the key sits', () => {
    for (const url of ['https://rpc.io/v2/KEY', 'https://rpc.io/?apikey=KEY', 'https://user:KEY@rpc.io/x', 'https://KEY.rpc.io/x#frag', 'wss://KEY.eu.rpc.io:8443/ws']) {
      expect(redactUrlsKeepDomain(`failed calling ${url} today`), url).toBe('failed calling [url: rpc.io] today');
    }
  });

  it('covers database and cache URLs, and keeps an IP address or a bare host whole', () => {
    expect(redactUrlsKeepDomain('connect redis://:hunter2@cache.internal:6379 failed')).toBe('connect [url: cache.internal] failed');
    expect(redactUrlsKeepDomain('postgres://app:pw@10.0.0.7/stryx refused')).toBe('[url: 10.0.0.7] refused');
    expect(redactUrlsKeepDomain('http://localhost:8545/KEY')).toBe('[url: localhost]');
  });

  it('survives a URL run together with the text after it, as in a JSON-escaped error', () => {
    expect(redactUrlsKeepDomain('URL: https://eth-mainnet.g.alchemy.com/v2/KEY\\nRequest body: {}')).toBe('URL: [url: alchemy.com] body: {}');
  });

  it('falls back to a plain [url] when the URL cannot be parsed', () => {
    expect(redactUrlsKeepDomain('redis://:pa/ss@host failed')).toBe(`${REDACTED_URL} failed`);
  });
});
