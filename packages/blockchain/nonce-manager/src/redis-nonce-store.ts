import { randomUUID } from 'node:crypto';
import type { NonceRedisClient, NonceScope } from './types.js';

/** Compare-and-delete Lua script for safely releasing a lock we own. */
const UNLOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/** Raises the counter to a floor (never lowers it) and drops released nonces below that floor, in one step. */
const ADVANCE_SCRIPT = `
local current = tonumber(redis.call("get", KEYS[1]))
if current == nil then return 0 end
if current < tonumber(ARGV[1]) then redis.call("set", KEYS[1], ARGV[1]) end
redis.call("zremrangebyscore", KEYS[2], "-inf", "(" .. ARGV[1])
return 1
`;

/**
 * Pulls the counter back to the chain's pending nonce when it has run ahead and the wallet has been
 * quiet. Returns the old counter, or -1 if nothing changed.
 */
const RESET_AHEAD_SCRIPT = `
local current = tonumber(redis.call("get", KEYS[1]))
if current == nil then return -1 end
if current <= tonumber(ARGV[1]) then return -1 end
local last = tonumber(redis.call("get", KEYS[3]))
if last ~= nil and tonumber(ARGV[2]) - last < tonumber(ARGV[3]) then return -1 end
redis.call("set", KEYS[1], ARGV[1])
redis.call("del", KEYS[2])
return current
`;
/** Owns the Redis key layout and every atomic primitive operation needed by NonceManager. */
export class RedisNonceStore {
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: NonceRedisClient,
    keyPrefix = 'nonce',
  ) {
    this.keyPrefix = keyPrefix;
  }

  private nextKey(scope: NonceScope): string {
    return `${this.keyPrefix}:${scope.chainId}:${scope.walletAddress.toLowerCase()}:next`;
  }

  private releasedKey(scope: NonceScope): string {
    return `${this.keyPrefix}:${scope.chainId}:${scope.walletAddress.toLowerCase()}:released`;
  }

  private activeKey(scope: NonceScope): string {
    return `${this.keyPrefix}:${scope.chainId}:${scope.walletAddress.toLowerCase()}:active`;
  }
  private lockKey(scope: NonceScope): string {
    return `${this.keyPrefix}:${scope.chainId}:${scope.walletAddress.toLowerCase()}:init-lock`;
  }

  async isInitialized(scope: NonceScope): Promise<boolean> {
    return (await this.redis.exists(this.nextKey(scope))) === 1;
  }

  /** Sets the counter to `value` ONLY if it does not already exist. */
  async initializeIfAbsent(scope: NonceScope, value: number): Promise<boolean> {
    const result = await this.redis.set(this.nextKey(scope), String(value), { NX: true });
    return result === 'OK';
  }

  /** Force-sets the counter regardless of current value. */
  async forceSet(scope: NonceScope, value: number): Promise<void> {
    await this.redis.set(this.nextKey(scope), String(value));
    // Released nonces below the new floor are stale.
    await this.redis.del(this.releasedKey(scope));
  }

  /** Moves the counter up to `floor` if it is behind. A no-op on an uninitialized wallet. */
  async advanceTo(scope: NonceScope, floor: number): Promise<void> {
    await this.redis.eval(ADVANCE_SCRIPT, [this.nextKey(scope), this.releasedKey(scope)], [String(floor)]);
  }

  /** Records that a nonce was just handed out, so resetIfAhead leaves a wallet in use alone. */
  async touch(scope: NonceScope, nowMs: number, ttlMs: number): Promise<void> {
    await this.redis.set(this.activeKey(scope), String(nowMs), { PX: ttlMs });
  }
  /** When this wallet last had a nonce handed out, or null if not within the marker's lifetime. */
  async lastActive(scope: NonceScope): Promise<number | null> {
    const raw = await this.redis.get(this.activeKey(scope));
    return raw === null ? null : Number(raw);
  }
  /** See RESET_AHEAD_SCRIPT. Returns the counter's old value if it was pulled back, else null. */
  async resetIfAhead(scope: NonceScope, chainPending: number, nowMs: number, quietMs: number): Promise<number | null> {
    const result = Number(
      await this.redis.eval(RESET_AHEAD_SCRIPT, [this.nextKey(scope), this.releasedKey(scope), this.activeKey(scope)], [String(chainPending), String(nowMs), String(quietMs)]),
    );
    return result >= 0 ? result : null;
  }
  async getNext(scope: NonceScope): Promise<number | null> {
    const raw = await this.redis.get(this.nextKey(scope));
    return raw === null ? null : Number(raw);
  }

  /**
   * Allocates the next nonce: a released one first (smallest first), otherwise the counter. Null if
   * the store is not initialized.
   */
  async allocate(scope: NonceScope): Promise<number | null> {
    const popped = await this.redis.zpopmin(this.releasedKey(scope), 1);
    if (popped.length > 0) {
      return Number(popped[0]);
    }

    if (!(await this.isInitialized(scope))) {
      return null;
    }

    const newCounterValue = await this.redis.incr(this.nextKey(scope));
    return newCounterValue - 1;
  }

  /** Returns an unused nonce to the reuse pool. False if that nonce was never handed out. */
  async release(scope: NonceScope, nonce: number): Promise<boolean> {
    const next = await this.getNext(scope);
    if (next === null || nonce >= next || nonce < 0) {
      return false;
    }
    await this.redis.zadd(this.releasedKey(scope), nonce, String(nonce));
    return true;
  }

  async releasedCount(scope: NonceScope): Promise<number> {
    return this.redis.zcard(this.releasedKey(scope));
  }

  /**
   * Acquires a short-lived distributed lock so only one process initializes the counter from chain
   * state under concurrent cold-start.
   */
  async acquireInitLock(scope: NonceScope, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(this.lockKey(scope), token, { NX: true, PX: ttlMs });
    return result === 'OK' ? token : null;
  }

  async releaseInitLock(scope: NonceScope, token: string): Promise<void> {
    await this.redis.eval(UNLOCK_SCRIPT, [this.lockKey(scope)], [token]);
  }
}
