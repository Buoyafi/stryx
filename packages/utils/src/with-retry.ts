/** True when Node's fetch threw a network failure: DNS, refused, timeout or reset. */
export function isFetchTransportFailure(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/** What went wrong under Node's generic "fetch failed", in plain words. */
export function describeFetchFailure(err: unknown): string {
  const codes: string[] = [];
  const walk = (e: unknown, depth: number) => {
    if (!e || typeof e !== 'object' || depth > 5) return;
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    if (e instanceof AggregateError) for (const inner of e.errors) walk(inner, depth + 1);
    walk((e as { cause?: unknown }).cause, depth + 1);
  };
  walk(err, 0);
  const has = (...c: string[]) => codes.some((x) => c.includes(x));
  if (has('ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT')) return 'the connection timed out';
  if (has('UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT')) return 'the server took too long to answer';
  if (has('ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE')) return 'the connection was dropped';
  if (has('ECONNREFUSED')) return 'the connection was refused';
  if (has('ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL')) return 'the DNS lookup failed';
  if (has('ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN')) return 'there is no network route to it';
  if (codes.some((c) => c.startsWith('ERR_TLS') || c.includes('CERT'))) return 'the secure (TLS) connection failed';
  if (codes.length > 0) return `network error ${codes[0]}`;
  return 'the request never got an answer';
}

export interface WithRetryOptions {
  /** Total attempts, including the first. */
  attempts: number;
  /** Fixed delay between attempts, ms. */
  delayMs: number;
  /** Only retry when this returns true for the error that was thrown; anything else rethrows immediately, no delay. */
  isRetryable: (err: unknown) => boolean;
}

/** Retries `fn` up to `attempts` times, only for errors `isRetryable` accepts. */
export async function withRetry<T>(fn: () => Promise<T>, opts: WithRetryOptions): Promise<T> {
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === opts.attempts || !opts.isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
  }
  /* istanbul ignore next -- unreachable: the loop above always either returns or throws */
  throw new Error('unreachable');
}
