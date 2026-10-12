import { randomUUID } from 'node:crypto';

/** The minimal Redis surface this needs; a real ioredis instance satisfies it. */
export interface SpendingCapRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  set(key: string, value: string, opts: { NX?: boolean; PX?: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export type SpendingCapReservation =
  /** `day` is the UTC day it was counted against: a release gives it back to that day. */
  | { ok: true; total: bigint; day?: string }
  | { ok: false; attemptedTotal: bigint; capWei: bigint };

/**
 * Compare-and-delete: release the lock only if it still holds our token, so a slow caller cannot
 * delete another caller's lock.
 */
const UNLOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/** How long a lock is held before it self-expires if its holder crashes mid-reservation. */
const LOCK_TTL_MS = 3_000;
/** Poll interval while waiting for another reservation on the same user to finish. */
const LOCK_RETRY_DELAY_MS = 15;
/** Upper bound on how long `reserve`/`release` will wait for the lock. */
const LOCK_MAX_WAIT_MS = 2_000;

/**
 * ADR-002 §3.7: a per-user daily spending cap, checked before signing. Tracks cumulative wei per
 * budget (`{userId}:{chainId}`) per UTC day in Redis. The arithmetic stays in BigInt here, because wei
 * exceeds what Redis INCRBY or Lua hold exactly, so each read-then-write runs under a short per-user
 * lock: a mint batch reserves against one cap concurrently.
 */
const utcDay = (): string => new Date().toISOString().slice(0, 10); // yyyy-mm-dd

export class SpendingCapGuard {
  constructor(
    private readonly redis: SpendingCapRedisClient,
    private readonly keyPrefix = 'spend',
    /**
     * How long an unused day's counter lingers before Redis expires it: a little over 24h so a day's
     * final transactions aren't cut off by clock skew.
     */
    private readonly ttlSeconds = 60 * 60 * 25,
  ) {}

  /** Reserves `amountWei` against `userId`'s spend for today. */
  async reserve(userId: string, amountWei: bigint, capWei: bigint | null): Promise<SpendingCapReservation> {
    if (capWei === null) return { ok: true, total: amountWei };

    return this.withUserLock(userId, async () => {
      const day = utcDay();
      const key = this.dayKey(userId, day);
      const current = BigInt((await this.redis.get(key)) ?? '0');
      const attemptedTotal = current + amountWei;
      if (attemptedTotal > capWei) return { ok: false, attemptedTotal, capWei };

      await this.redis.set(key, attemptedTotal.toString(), 'EX', this.ttlSeconds);
      return { ok: true, total: attemptedTotal, day };
    });
  }

  /** Rolls back a reservation when a transaction fails after `reserve` and before it was sent. */
  async release(userId: string, amountWei: bigint, capWei: bigint | null, day?: string): Promise<void> {
    if (capWei === null) return;

    await this.withUserLock(userId, async () => {
      // The reservation's own day: one made before midnight and released after it belongs to yesterday.
      const key = this.dayKey(userId, day ?? utcDay());
      const current = BigInt((await this.redis.get(key)) ?? '0');
      const next = current - amountWei;
      // Floor at zero: a release never pushes the counter negative.
      const clamped = next < 0n ? 0n : next;
      await this.redis.set(key, clamped.toString(), 'EX', this.ttlSeconds);
    });
  }

  /**
   * Runs `fn` while holding `userId`'s reservation lock, waiting (bounded by LOCK_MAX_WAIT_MS) if
   * another reservation for the same user is in flight.
   */
  private async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const key = this.lockKey(userId);
    const token = randomUUID();
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;

    for (;;) {
      const acquired = await this.redis.set(key, token, { NX: true, PX: LOCK_TTL_MS });
      if (acquired === 'OK') break;
      if (Date.now() >= deadline) {
        throw new Error(`Could not acquire spending-cap lock for user=${userId} within ${LOCK_MAX_WAIT_MS}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }

    try {
      return await fn();
    } finally {
      // A failure releasing the lock never masks what fn() threw; the lock's TTL is the backstop.
      await this.redis.eval(UNLOCK_SCRIPT, [key], [token]).catch(() => undefined);
    }
  }

  private dayKey(userId: string, day: string): string {
    return `${this.keyPrefix}:${userId}:${day}`;
  }

  private lockKey(userId: string): string {
    return `${this.keyPrefix}:lock:${userId}`;
  }
}
