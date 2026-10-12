import type { SessionRedisClient } from '../../src/session-store.js';
import { RATE_LIMIT_SCRIPT } from '../../src/rate-limiter.js';

export class InMemoryRedisClient implements SessionRedisClient {
  private readonly strings = new Map<string, string>();
  private readonly expiresAt = new Map<string, number>();

  /** Every key held, for tests that check what is (and is not) stored. */
  keys(): string[] {
    return [...this.strings.keys()];
  }

  async set(key: string, value: string, mode?: 'EX', seconds?: number, nx?: 'NX'): Promise<unknown> {
    if (nx === 'NX' && (await this.get(key)) !== null) return null;
    this.strings.set(key, value);
    if (mode === 'EX' && seconds !== undefined) {
      this.expiresAt.set(key, Date.now() + seconds * 1000);
    } else {
      this.expiresAt.delete(key);
    }
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const expiry = this.expiresAt.get(key);
    if (expiry !== undefined && Date.now() >= expiry) {
      this.strings.delete(key);
      this.expiresAt.delete(key);
      return null;
    }
    return this.strings.get(key) ?? null;
  }

  async del(key: string): Promise<unknown> {
    this.expiresAt.delete(key);
    const hadSet = this.sets.delete(key);
    return this.strings.delete(key) || hadSet ? 1 : 0;
  }

  /** One step, as in Redis: no other command can run between the read and the delete. */
  async getdel(key: string): Promise<string | null> {
    const expiry = this.expiresAt.get(key);
    const value = expiry !== undefined && Date.now() >= expiry ? null : (this.strings.get(key) ?? null);
    this.strings.delete(key);
    this.expiresAt.delete(key);
    return value;
  }

  /** ioredis's eval shape. Knows the one script the app sends through it: the rate limiter's. */
  async eval(script: string, numKeys: number, ...rest: Array<string | number>): Promise<unknown> {
    if (script !== RATE_LIMIT_SCRIPT) throw new Error('InMemoryRedisClient.eval: a script this fake does not know');
    const key = String(rest[0]);
    void numKeys;
    const count = await this.incr(key);
    if (count === 1 || !this.expiresAt.has(key)) await this.expire(key, Number(rest[1]));
    return count;
  }

  async incr(key: string): Promise<number> {
    const next = Number((await this.get(key)) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.strings.has(key) && !this.sets.has(key)) return 0;
    this.expiresAt.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  private readonly sets = new Map<string, Set<string>>();

  private liveSet(key: string): Set<string> | undefined {
    const expiry = this.expiresAt.get(key);
    if (expiry !== undefined && Date.now() >= expiry) {
      this.sets.delete(key);
      this.expiresAt.delete(key);
    }
    return this.sets.get(key);
  }

  async sadd(key: string, member: string): Promise<number> {
    const set = this.liveSet(key) ?? new Set<string>();
    const had = set.has(member);
    set.add(member);
    this.sets.set(key, set);
    return had ? 0 : 1;
  }

  async srem(key: string, member: string): Promise<number> {
    return this.liveSet(key)?.delete(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.liveSet(key) ?? [])];
  }
}
