import type Redis from 'ioredis';
import type { NonceRedisClient } from '@stryx/nonce-manager';
import type { EmergencyStopRedisClient, SpendingCapRedisClient } from '@stryx/transaction-engine';

/**
 * Adapts a real ioredis instance to the structural NonceRedisClient / EmergencyStopRedisClient /
 * SpendingCapRedisClient interfaces those packages depend on.
 */
export class RedisAdapter implements NonceRedisClient, EmergencyStopRedisClient, SpendingCapRedisClient {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  async exists(key: string): Promise<number> {
    return this.redis.exists(key);
  }

  async del(key: string): Promise<number> {
    return this.redis.del(key);
  }

  async set(
    key: string,
    value: string,
    arg3?: { NX?: boolean; PX?: number } | 'EX',
    arg4?: number,
  ): Promise<'OK' | null> {
    if (arg3 === 'EX' && typeof arg4 === 'number') {
      return this.redis.set(key, value, 'EX', arg4);
    }
    if (arg3 && typeof arg3 === 'object') {
      if (arg3.NX && arg3.PX) return this.redis.set(key, value, 'PX', arg3.PX, 'NX');
      if (arg3.NX) return this.redis.set(key, value, 'NX');
      if (arg3.PX) return this.redis.set(key, value, 'PX', arg3.PX);
    }
    return this.redis.set(key, value);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.redis.zadd(key, score, member);
  }

  async zpopmin(key: string, count = 1): Promise<string[]> {
    // ioredis returns a flat [member, score, member, score, ...] array, NonceManager only needs the
    // members, in the order returned.
    const raw = await this.redis.zpopmin(key, count);
    const members: string[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i];
      if (member !== undefined) members.push(member);
    }
    return members;
  }

  async zrem(key: string, member: string): Promise<number> {
    return this.redis.zrem(key, member);
  }

  async zcard(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.redis.eval(script, keys.length, ...keys, ...args);
  }
}
