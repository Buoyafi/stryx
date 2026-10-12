import type { NonceRedisClient } from '../src/types.js';

/** A dependency-free stand-in for Redis that implements the NonceRedisClient contract with the same atomicity. */
export class InMemoryRedisClient implements NonceRedisClient {
  private strings = new Map<string, string>();
  private sortedSets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async incr(key: string): Promise<number> {
    const current = Number(this.strings.get(key) ?? '0');
    const next = current + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async exists(key: string): Promise<number> {
    return this.strings.has(key) || this.sortedSets.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    const had = this.strings.delete(key);
    const hadSet = this.sortedSets.delete(key);
    return had || hadSet ? 1 : 0;
  }

  async set(key: string, value: string, opts?: { NX?: boolean; PX?: number }): Promise<'OK' | null> {
    if (opts?.NX && this.strings.has(key)) {
      return null;
    }
    this.strings.set(key, value);
    if (opts?.PX) {
      setTimeout(() => this.strings.delete(key), opts.PX).unref?.();
    }
    return 'OK';
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    const isNew = !set.has(member);
    set.set(member, score);
    this.sortedSets.set(key, set);
    return isNew ? 1 : 0;
  }

  async zpopmin(key: string, count = 1): Promise<string[]> {
    const set = this.sortedSets.get(key);
    if (!set || set.size === 0) return [];
    const sorted = [...set.entries()].sort((a, b) => a[1] - b[1]);
    const popped = sorted.slice(0, count);
    for (const [member] of popped) set.delete(member);
    return popped.map(([member]) => member);
  }

  async zrem(key: string, member: string): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }

  async zcard(key: string): Promise<number> {
    return this.sortedSets.get(key)?.size ?? 0;
  }

  /** Only supports the single compare-and-delete unlock script this package uses. */
  async eval(_script: string, keys: string[], args: string[]): Promise<unknown> {
    if (keys.length === 3) return this.resetIfAhead(keys[0]!, keys[1]!, keys[2]!, Number(args[0]), Number(args[1]), Number(args[2]));
    if (keys.length === 2) return this.advance(keys[0]!, keys[1]!, Number(args[0]));
    const [lockKey] = keys;
    const [token] = args;
    if (lockKey === undefined || token === undefined) return 0;
    if (this.strings.get(lockKey) === token) {
      this.strings.delete(lockKey);
      return 1;
    }
    return 0;
  }

  /** The reset-if-ahead script: pull the counter back to the chain when it is ahead and the wallet is quiet. */
  private resetIfAhead(nextKey: string, releasedKey: string, activeKey: string, chainPending: number, now: number, quietMs: number): number {
    const current = this.strings.get(nextKey);
    if (current === undefined || Number(current) <= chainPending) return -1;
    const last = this.strings.get(activeKey);
    if (last !== undefined && now - Number(last) < quietMs) return -1;
    this.strings.set(nextKey, String(chainPending));
    this.sortedSets.delete(releasedKey);
    return Number(current);
  }

  /** The counter-advance script: raise the counter to a floor, drop released nonces below it. */
  private advance(nextKey: string, releasedKey: string, floor: number): number {
    const current = this.strings.get(nextKey);
    if (current === undefined) return 0;
    if (Number(current) < floor) this.strings.set(nextKey, String(floor));
    const released = this.sortedSets.get(releasedKey);
    if (released) for (const [member, score] of released) if (score < floor) released.delete(member);
    return 1;
  }
}
