import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpendingCapGuard } from '../src/service/spending-cap.service.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';

describe('SpendingCapGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reserves within the cap and reports the running total', async () => {
    const guard = new SpendingCapGuard(new InMemoryRedisClient());

    const first = await guard.reserve('user-1', 100n, 1000n);
    expect(first).toMatchObject({ ok: true, total: 100n });

    const second = await guard.reserve('user-1', 200n, 1000n);
    expect(second).toMatchObject({ ok: true, total: 300n });
  });

  it('refuses a reservation that would exceed the cap, and does not partially apply it', async () => {
    const guard = new SpendingCapGuard(new InMemoryRedisClient());
    await guard.reserve('user-1', 900n, 1000n);

    const result = await guard.reserve('user-1', 200n, 1000n);
    expect(result).toEqual({ ok: false, attemptedTotal: 1100n, capWei: 1000n });

    // The refused reservation must not have been applied.
    const next = await guard.reserve('user-1', 100n, 1000n);
    expect(next).toMatchObject({ ok: true, total: 1000n }); // 900 + 100, not 900 + 200 + 100
  });

  it('tracks separate users independently', async () => {
    const guard = new SpendingCapGuard(new InMemoryRedisClient());
    await guard.reserve('user-1', 900n, 1000n);

    const userTwo = await guard.reserve('user-2', 900n, 1000n);
    expect(userTwo).toMatchObject({ ok: true, total: 900n });
  });

  it('unlimited (capWei: null) always succeeds and tracks nothing', async () => {
    const redis = new InMemoryRedisClient();
    const guard = new SpendingCapGuard(redis);

    const result = await guard.reserve('operator', 999_999_999n, null);
    expect(result).toMatchObject({ ok: true, total: 999_999_999n });
    // No key was ever written for this user.
    expect(await redis.get('spend:operator:' + new Date().toISOString().slice(0, 10))).toBeNull();
  });

  it('release rolls back a reservation so a later one can succeed', async () => {
    const guard = new SpendingCapGuard(new InMemoryRedisClient());
    await guard.reserve('user-1', 900n, 1000n);

    await guard.release('user-1', 900n, 1000n);

    const result = await guard.reserve('user-1', 900n, 1000n);
    expect(result).toMatchObject({ ok: true, total: 900n }); // back to a clean slate
  });

  it('a reservation made before midnight UTC is released to that day, not the next', async () => {
    const redis = new InMemoryRedisClient();
    const guard = new SpendingCapGuard(redis);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T23:59:59.900Z'));
    const reservation = await guard.reserve('user-1', 900n, 1000n);
    vi.setSystemTime(new Date('2026-10-09T00:00:00.100Z'));

    await guard.release('user-1', 900n, 1000n, reservation.ok ? reservation.day : undefined);

    expect(await redis.get('spend:user-1:2026-10-08')).toBe('0');
    expect(await redis.get('spend:user-1:2026-10-09')).toBeNull();
  });

  it('release is a no-op for an unlimited user', async () => {
    const redis = new InMemoryRedisClient();
    const guard = new SpendingCapGuard(redis);

    await guard.release('operator', 500n, null);

    expect(await redis.get('spend:operator:' + new Date().toISOString().slice(0, 10))).toBeNull();
  });

  it('release floors at zero rather than going negative', async () => {
    const guard = new SpendingCapGuard(new InMemoryRedisClient());
    await guard.reserve('user-1', 100n, 1000n);

    // Releasing more than was ever reserved (shouldn't happen in practice, but must not corrupt the
    // counter into a negative running total).
    await guard.release('user-1', 500n, 1000n);

    const result = await guard.reserve('user-1', 1000n, 1000n);
    expect(result).toMatchObject({ ok: true, total: 1000n }); // 0 + 1000, not negative + 1000
  });

  it('handles a value exactly at the cap boundary as allowed, one wei over as refused', async () => {
    const guard = new SpendingCapGuard(new InMemoryRedisClient());

    expect(await guard.reserve('user-1', 1000n, 1000n)).toMatchObject({ ok: true, total: 1000n });

    const guard2 = new SpendingCapGuard(new InMemoryRedisClient());
    expect(await guard2.reserve('user-2', 1001n, 1000n)).toEqual({
      ok: false,
      attemptedTotal: 1001n,
      capWei: 1000n,
    });
  });

  it('handles amounts well beyond JS safe-integer / int64 range without precision loss', async () => {
    // 1000 ETH in wei: far past Number.MAX_SAFE_INTEGER and Redis INCRBY's range.
    const huge = 1_000_000_000_000_000_000_000n; // 1000 * 10^18
    const guard = new SpendingCapGuard(new InMemoryRedisClient());

    const result = await guard.reserve('whale', huge, huge + 1n);
    expect(result).toMatchObject({ ok: true, total: huge });
  });

  it('fails closed: if Redis is unreadable, reserve() REJECTS rather than treating today\'s spend as zero', async () => {
    const unreadable = {
      // The lock itself must be acquirable; this test is about the counter read failing.
      async set(_key: string, _value: string, opts?: unknown): Promise<unknown> {
        if (opts && typeof opts === 'object' && 'NX' in opts) return 'OK';
        throw new Error('should never be reached: get() failed first');
      },
      async get(): Promise<string | null> {
        throw new Error('simulated Redis outage');
      },
      async eval(): Promise<unknown> {
        return 1; // lock release: irrelevant to what's under test here
      },
    };
    const guard = new SpendingCapGuard(unreadable);

    // Not { ok: false, ...
    await expect(guard.reserve('user-1', 100n, 1000n)).rejects.toThrow('simulated Redis outage');
  });

  it('fails closed: an unlimited user (capWei: null) still short-circuits before ever touching Redis, so this is not a false negative for the fail-closed test above', async () => {
    const unreadable = {
      async get(): Promise<string | null> {
        throw new Error('should not be called for an unlimited user');
      },
      async set(): Promise<unknown> {
        throw new Error('should not be called for an unlimited user');
      },
      async eval(): Promise<unknown> {
        throw new Error('should not be called for an unlimited user');
      },
    };
    const guard = new SpendingCapGuard(unreadable);

    await expect(guard.reserve('operator', 100n, null)).resolves.toMatchObject({ ok: true, total: 100n });
  });

  it('holds under concurrency: N simultaneous reservations against a cap that permits fewer than N never let the running total exceed the cap', async () => {
    // 10 concurrent mints of 150n each, against a cap of 1000n: the cap permits exactly 6 (900n), so
    // at most 6 of the 10 may succeed.
    const guard = new SpendingCapGuard(new InMemoryRedisClient());
    const AMOUNT = 150n;
    const CAP = 1000n;
    const ATTEMPTS = 10;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => guard.reserve('batch-user', AMOUNT, CAP)),
    );

    const succeeded = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);

    expect(succeeded).toHaveLength(6); // floor(1000/150)
    expect(refused).toHaveLength(4);

    // The load-bearing assertion: the total actually reserved never exceeds the cap, regardless of how
    // many callers raced for it.
    const finalTotal = succeeded.length * Number(AMOUNT);
    expect(finalTotal).toBeLessThanOrEqual(Number(CAP));

    // Every successful reservation's running total is consistent: each exactly AMOUNT more than the
    // last.
    const totals = succeeded.map((r) => (r as { ok: true; total: bigint }).total).sort((a, b) => (a < b ? -1 : 1));
    totals.forEach((total, i) => expect(total).toBe(AMOUNT * BigInt(i + 1)));
  });
});
