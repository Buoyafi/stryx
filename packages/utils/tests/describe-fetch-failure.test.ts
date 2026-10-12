import { describe, expect, it } from 'vitest';
import { describeFetchFailure } from '../src/with-retry.js';

const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });
const coded = (code: string) => Object.assign(new Error(code), { code });

describe('describeFetchFailure', () => {
  it('turns undici socket codes into plain words, digging through nested causes', () => {
    expect(describeFetchFailure(fetchFailed(coded('ETIMEDOUT')))).toBe('the connection timed out');
    expect(describeFetchFailure(fetchFailed(coded('UND_ERR_CONNECT_TIMEOUT')))).toBe('the connection timed out');
    expect(describeFetchFailure(fetchFailed(coded('ECONNRESET')))).toBe('the connection was dropped');
    expect(describeFetchFailure(fetchFailed(coded('EAI_AGAIN')))).toBe('the DNS lookup failed');
    expect(describeFetchFailure(fetchFailed({ cause: coded('ENETUNREACH') }))).toBe('there is no network route to it');
  });

  it('reads an AggregateError (one error per address tried)', () => {
    expect(describeFetchFailure(fetchFailed(new AggregateError([coded('ENETUNREACH'), coded('ETIMEDOUT')])))).toBe('the connection timed out');
  });

  it('falls back to the first code, then to a generic sentence', () => {
    expect(describeFetchFailure(fetchFailed(coded('EWEIRD')))).toBe('network error EWEIRD');
    expect(describeFetchFailure(new TypeError('fetch failed'))).toBe('the request never got an answer');
  });
});
