import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeFetchFailure, isFetchTransportFailure } from '@stryx/utils';
import { timedFetch } from '../src/timed-fetch.js';

afterEach(() => vi.unstubAllGlobals());

/** A server that accepts the request and never answers, until the caller gives up. */
const silentServer = () =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }),
  );

describe('timedFetch', () => {
  it('gives up on a server that never answers, as an ordinary failed connection the callers already handle', async () => {
    vi.stubGlobal('fetch', silentServer());
    const err = await timedFetch(20)('https://api.example/x').catch((e: unknown) => e);
    expect(isFetchTransportFailure(err)).toBe(true);
    expect(describeFetchFailure(err)).toBe('the server took too long to answer');
  });

  it('passes an answer straight through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    const res = await timedFetch(1_000)('https://api.example/x', { method: 'POST', body: '{}' });
    expect(await res.json()).toEqual({ ok: true });
  });

  it("the caller's own cancel still reads as the caller's, not as a timeout", async () => {
    vi.stubGlobal('fetch', silentServer());
    const mine = new AbortController();
    const pending = timedFetch(5_000)('https://api.example/x', { signal: mine.signal }).catch((e: unknown) => e);
    mine.abort(new Error('caller gave up'));
    const err = await pending;
    expect(isFetchTransportFailure(err)).toBe(false);
    expect((err as Error).message).toBe('caller gave up');
  });
});
