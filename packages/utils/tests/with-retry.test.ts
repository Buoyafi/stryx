import { describe, expect, it, vi } from 'vitest';
import { withRetry, isFetchTransportFailure } from '../src/with-retry.js';

describe('isFetchTransportFailure', () => {
  it('recognizes the exact shape Node\'s fetch/undici throws for a network-transport failure', () => {
    expect(isFetchTransportFailure(new TypeError('fetch failed'))).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding text', () => {
    expect(isFetchTransportFailure(new TypeError('Fetch Failed: ECONNREFUSED'))).toBe(true);
  });

  it('is false for an HTTP error response already turned into a real error (not a raw fetch failure)', () => {
    expect(isFetchTransportFailure(new Error('OpenSea API returned 429 for collection "x".'))).toBe(false);
  });

  it('is false for a TypeError with unrelated text', () => {
    expect(isFetchTransportFailure(new TypeError('Cannot read properties of undefined'))).toBe(false);
  });

  it('is false for a non-Error value', () => {
    expect(isFetchTransportFailure('fetch failed')).toBe(false);
    expect(isFetchTransportFailure(null)).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the result on the first try when it succeeds, never sleeping', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, { attempts: 3, delayMs: 10_000, isRetryable: () => true });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and succeeds on a later attempt', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return 'ok';
    });
    const result = await withRetry(fn, { attempts: 3, delayMs: 1, isRetryable: isFetchTransportFailure });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error once attempts are exhausted', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(withRetry(fn, { attempts: 3, delayMs: 1, isRetryable: isFetchTransportFailure })).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-retryable error immediately, on the first attempt, with no delay and no further attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('a real 429 from the server');
    });
    const start = Date.now();
    await expect(withRetry(fn, { attempts: 5, delayMs: 5_000, isRetryable: isFetchTransportFailure })).rejects.toThrow('a real 429');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('waits delayMs between attempts', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new TypeError('fetch failed');
      return 'ok';
    });
    const start = Date.now();
    await withRetry(fn, { attempts: 2, delayMs: 200, isRetryable: isFetchTransportFailure });
    expect(Date.now() - start).toBeGreaterThanOrEqual(190);
  });
});
