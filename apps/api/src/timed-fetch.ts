/** `fetch` with a time limit. */
export function timedFetch(timeoutMs = 10_000): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const limit = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, limit]) : limit;
    try {
      return await fetch(url, { ...init, signal });
    } catch (err) {
      if (!limit.aborted || init?.signal?.aborted) throw err;
      throw new TypeError('fetch failed', { cause: Object.assign(new Error(`no answer within ${timeoutMs}ms`), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    }
  };
}
