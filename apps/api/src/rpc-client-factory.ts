import { createPublicClient, http, fallback, BaseError, TimeoutError, HttpRequestError, SocketClosedError, type PublicClient, type Transport } from 'viem';
import type { AppConfig } from '@stryx/config';
import type { Logger } from '@stryx/logger';
import { rpcUrlFor, rpcFallbackUrlFor, configuredChainIds } from './chain-registry.js';

/**
 * Creates a viem PublicClient for a chain from the RPC URLs in config. With a primary and a fallback,
 * a transport failure on one moves to the other; a revert is an answer and never does.
 */
export function createChainPublicClient(config: AppConfig, chainId: number, logger?: Logger): PublicClient {
  const primaryUrl = rpcUrlFor(config, chainId);
  const fallbackUrl = rpcFallbackUrlFor(config, chainId);

  if (!primaryUrl && !fallbackUrl) {
    throw new Error(
      `No RPC URL configured for chainId=${chainId}. Set its RPC_* env var (see chain-registry.ts for the mapping).`,
    );
  }

  if (primaryUrl && fallbackUrl) {
    const client = createPublicClient({ transport: buildFallbackTransport(primaryUrl, fallbackUrl) });
    if (logger) attachEndpointLogging(client, primaryUrl, fallbackUrl, chainId, logger);
    return client;
  }

  // Exactly one of the two is set: use it as the sole endpoint.
  if (fallbackUrl && !primaryUrl) {
    logger?.warn('chain RPC running fallback-only: primary endpoint not configured', { chainId });
  }
  return createPublicClient({ transport: http((primaryUrl ?? fallbackUrl)!, { timeout: 5_000, retryCount: 1, retryDelay: 300 }) });
}

/**
 * Which failures are worth trying the other endpoint for: timeouts, connection failures and 429/5xx
 * responses. A revert or any other real answer is not.
 */
function isFallbackWorthy(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return (
    err.walk(
      (e) =>
        e instanceof TimeoutError ||
        e instanceof SocketClosedError ||
        (e instanceof HttpRequestError && (e.status === undefined || e.status === 429 || e.status >= 500)),
    ) !== null
  );
}

function buildFallbackTransport(primaryUrl: string, fallbackUrl: string): Transport {
  // retryCount: 0 on each endpoint is deliberate: the fallback transport does the retrying, so a
  // failing endpoint is left after one attempt.
  return fallback([http(primaryUrl, { timeout: 5_000, retryCount: 0 }), http(fallbackUrl, { timeout: 5_000, retryCount: 0 })], {
    shouldThrow: (err) => !isFallbackWorthy(err),
    retryCount: 1,
    retryDelay: 300,
  });
}

/** Hooks the client's own transport instance, so the log says which endpoint answered each request. */
function attachEndpointLogging(client: PublicClient, primaryUrl: string, fallbackUrl: string, chainId: number, logger: Logger): void {
  const normalize = (u: string) => new URL(u).toString();
  const primaryNormalized = normalize(primaryUrl);
  const fallbackNormalized = normalize(fallbackUrl);
  const transport = client.transport as unknown as { onResponse?: (fn: (args: { method: string; status: 'success' | 'error'; transport: { value?: { url?: string } } }) => void) => void };
  transport.onResponse?.(({ method, status, transport: served }) => {
    if (status === 'error') return; // the fallback's own internals already try the next endpoint; nothing final to log for a mid-sequence failure
    const url = served.value?.url ? normalize(served.value.url) : undefined;
    const endpoint = url === primaryNormalized ? 'primary' : url === fallbackNormalized ? 'fallback' : 'unknown';
    logger.debug('chain RPC request served', { chainId, method, endpoint });
  });
}

/** Starts every sender at once and returns the first to succeed. */
export async function firstToSucceed<T>(senders: ReadonlyArray<() => Promise<T>>, onWinner?: (index: number) => void): Promise<T> {
  const attempts = senders.map((send, index) =>
    send().then((value) => {
      onWinner?.(index);
      return value;
    }),
  );
  try {
    return await Promise.any(attempts);
  } catch {
    return await attempts[0]!;
  }
}

export interface RaceBroadcaster {
  /** Hands the signed transaction to every endpoint at once; the first to accept answers. */
  send(serializedTransaction: `0x${string}`): Promise<`0x${string}`>;
  /** One cheap read on every endpoint, so each has an open connection when `send` runs. */
  warm(): void;
}

/** For a chain with both a primary and a fallback RPC: broadcast to both at once. */
export function createRaceBroadcaster(config: AppConfig, chainId: number, client: PublicClient, logger?: Logger): RaceBroadcaster | undefined {
  const primaryUrl = rpcUrlFor(config, chainId);
  const fallbackUrl = rpcFallbackUrlFor(config, chainId);
  if (!config.RPC_RACE_BROADCAST || !primaryUrl || !fallbackUrl) return undefined;

  const names = ['primary', 'fallback'] as const;
  const endpoints = [primaryUrl, fallbackUrl].map((url) => createPublicClient({ transport: http(url, { timeout: 5_000, retryCount: 0 }) }));
  return {
    async send(serializedTransaction) {
      try {
        return await firstToSucceed(
          endpoints.map((endpoint) => () => endpoint.sendRawTransaction({ serializedTransaction })),
          (index) => logger?.debug('broadcast accepted first by', { chainId, endpoint: names[index] }),
        );
      } catch (err) {
        if (!isFallbackWorthy(err)) throw err;
        return client.sendRawTransaction({ serializedTransaction });
      }
    },
    warm() {
      for (const endpoint of endpoints) void endpoint.getBlockNumber().catch(() => undefined);
    },
  };
}

// Re-exported for existing importers.
export { configuredChainIds };
