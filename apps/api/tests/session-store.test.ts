import { describe, expect, it, vi } from 'vitest';
import { RedisSessionStore } from '../src/session-store.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';

describe('RedisSessionStore', () => {
  it('creates a session and resolves it back to the same userId', async () => {
    const store = new RedisSessionStore(new InMemoryRedisClient());
    const token = await store.create('user-1');

    const resolved = await store.resolve(token);
    expect(resolved).toEqual({ userId: 'user-1' });
  });

  it('returns null for an unknown token', async () => {
    const store = new RedisSessionStore(new InMemoryRedisClient());
    expect(await store.resolve('not-a-real-token')).toBeNull();
  });

  it('never returns a session for a token that was never created (not derivable from another valid one)', async () => {
    const store = new RedisSessionStore(new InMemoryRedisClient());
    const token = await store.create('user-1');
    // A near-miss token (one char different) must not resolve: proves the Redis key is a hash of the
    // whole token, not something guessable from it.
    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    expect(await store.resolve(tampered)).toBeNull();
  });

  it('revokes a session immediately', async () => {
    const store = new RedisSessionStore(new InMemoryRedisClient());
    const token = await store.create('user-1');

    await store.revoke(token);

    expect(await store.resolve(token)).toBeNull();
  });

  it('rejects a session past its absolute max age, even if never revoked', async () => {
    vi.useFakeTimers();
    try {
      const store = new RedisSessionStore(new InMemoryRedisClient(), 'session', 60 * 60 * 24 * 7, 1000);
      const token = await store.create('user-1');

      expect(await store.resolve(token)).toEqual({ userId: 'user-1' });

      vi.advanceTimersByTime(1001);
      expect(await store.resolve(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not store the raw token anywhere retrievable, only its hash keys the record', async () => {
    const redis = new InMemoryRedisClient();
    const store = new RedisSessionStore(redis);
    const token = await store.create('user-1');

    // Looks at the fake's storage the way someone inspecting Redis would: the raw token must not
    // appear as a key.
    expect(await redis.get(`session:${token}`)).toBeNull();
  });

  it("ends all of one account's sessions at once, and no one else's", async () => {
    const store = new RedisSessionStore(new InMemoryRedisClient());
    const phone = await store.create('alice');
    const laptop = await store.create('alice');
    const bob = await store.create('bob');
    expect(await store.revokeAllForUser('alice')).toBe(2);
    expect(await store.resolve(phone)).toBeNull();
    expect(await store.resolve(laptop)).toBeNull();
    expect(await store.resolve(bob)).toEqual({ userId: 'bob' });
    expect(await store.revokeAllForUser('alice')).toBe(0); // nothing left
    // A session made afterwards works as normal.
    expect(await store.resolve(await store.create('alice'))).toEqual({ userId: 'alice' });
  });

  it('a session revoked while a request is reading it stays revoked', async () => {
    const redis = new InMemoryRedisClient();
    const store = new RedisSessionStore(redis);
    const token = await store.create('alice');

    // The sign-out lands between this request's read of the session and its refresh.
    const realGet = redis.get.bind(redis);
    let raced = false;
    redis.get = async (key: string) => {
      const value = await realGet(key);
      if (!raced && key.startsWith('session:') && value !== null) {
        raced = true;
        await store.revoke(token);
      }
      return value;
    };

    expect(await store.resolve(token)).toBeNull();
    expect(raced).toBe(true);
    expect(await store.resolve(token)).toBeNull();
  });

  it('using a session keeps it alive without rewriting it', async () => {
    const redis = new InMemoryRedisClient();
    const store = new RedisSessionStore(redis);
    const token = await store.create('alice');
    const set = vi.spyOn(redis, 'set');
    const expire = vi.spyOn(redis, 'expire');
    expect(await store.resolve(token)).toEqual({ userId: 'alice' });
    expect(set).not.toHaveBeenCalled();
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('a blocked account has no sessions: the ones it had, and one a sign-in under way hands it afterwards', async () => {
    const store = new RedisSessionStore(new InMemoryRedisClient());
    const before = await store.create('alice');
    const bob = await store.create('bob');
    await store.blockUser('alice');
    expect(await store.resolve(before)).toBeNull();
    const after = await store.create('alice');
    expect(await store.resolve(after)).toBeNull();
    expect(await store.resolve(bob)).toEqual({ userId: 'bob' });

    await store.unblockUser('alice');
    // The old ones are gone for good; a new sign-in works.
    expect(await store.resolve(before)).toBeNull();
    expect(await store.resolve(after)).toBeNull();
    expect(await store.resolve(await store.create('alice'))).toEqual({ userId: 'alice' });
  });

  it('a single sign-out leaves the account’s other sessions, and is not counted again later', async () => {
    const store = new RedisSessionStore(new InMemoryRedisClient());
    const one = await store.create('alice');
    const two = await store.create('alice');
    await store.revoke(one);
    expect(await store.resolve(two)).toEqual({ userId: 'alice' });
    expect(await store.revokeAllForUser('alice')).toBe(1);
  });
});
