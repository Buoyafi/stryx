import { z } from 'zod';

/** A wallet nonce is scoped to a specific chain + address pair. */
export const NonceScopeSchema = z.object({
  chainId: z.number().int().positive(),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'walletAddress must be a checksum-agnostic 0x-prefixed 20-byte address'),
});
export type NonceScope = z.infer<typeof NonceScopeSchema>;

export const NonceValueSchema = z.number().int().nonnegative();

/** The minimal surface of a Redis-compatible client this package depends on. */
export interface NonceRedisClient {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  del(key: string): Promise<number>;
  /** Atomically set a key. NX = only if absent. PX = TTL in ms. Returns 'OK' or null if NX failed. */
  set(key: string, value: string, opts?: { NX?: boolean; PX?: number }): Promise<'OK' | null>;
  /** Add member with score to a sorted set. */
  zadd(key: string, score: number, member: string): Promise<number>;
  /** Atomically pop the lowest-scored member. Returns [] if the set is empty. */
  zpopmin(key: string, count?: number): Promise<string[]>;
  /** Remove specific members from a sorted set. */
  zrem(key: string, member: string): Promise<number>;
  /** Count members in a sorted set. */
  zcard(key: string): Promise<number>;
  /** Delete a key only if its value still matches, to release a lock we own. */
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/** Reads the authoritative on-chain nonce for a wallet. */
export interface ChainNonceReader {
  /** Returns the next nonce the chain expects, counting already-pending (mempool) transactions. */
  getPendingNonce(scope: NonceScope): Promise<number>;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface NonceManagerConfig {
  /** Prefix for all Redis keys this service owns. Default: 'nonce'. */
  keyPrefix?: string;
  /** TTL for the initialization lock, in ms. Default: 5000. */
  initLockTtlMs?: number;
  /** How many times to retry acquiring the init lock before giving up. Default: 60 (longer than the lock's TTL). */
  initLockRetries?: number;
  /** Delay between init-lock retry attempts, in ms. Default: 100. */
  initLockRetryDelayMs?: number;
  /** How long a wallet must be quiet before a counter ahead of the chain is treated as stuck and pulled back. */
  quietMs?: number;
  /** Clock, for tests. Default: Date.now. */
  now?: () => number;
}
