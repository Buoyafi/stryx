import { createHmac } from 'node:crypto';

/**
 * A fixed-window counter in Redis: `hit(key)` counts one attempt and says whether it is still within
 * `limit` for the current window.
 */
export interface RateLimitRedisClient {
  /** ioredis's shape: the script, how many of the following arguments are keys, then keys and args. */
  eval(script: string, numKeys: number, ...keysAndArgs: Array<string | number>): Promise<unknown>;
}

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

/** Counts one attempt and makes sure the window's clock is running, in one step. */
export const RATE_LIMIT_SCRIPT = `
local count = redis.call("incr", KEYS[1])
if count == 1 or redis.call("ttl", KEYS[1]) < 0 then redis.call("expire", KEYS[1], ARGV[1]) end
return count
`;

export class RedisRateLimiter {
  /** `secret` keys the hash that stands in for the subject in Redis. */
  constructor(
    private readonly redis: RateLimitRedisClient,
    private readonly prefix = 'ratelimit',
    private readonly secret = 'stryx-rate-limit',
  ) {}

  /** Records one attempt. Returns false once the limit for this window is used up. */
  async hit(bucket: string, subject: string, rule: RateLimitRule): Promise<boolean> {
    const count = Number(await this.redis.eval(RATE_LIMIT_SCRIPT, 1, this.keyFor(bucket, subject), rule.windowSeconds));
    return count <= rule.limit;
  }

  /** The subject is usually a visitor's IP address, which is personal data: it is never a Redis key as is. */
  keyFor(bucket: string, subject: string): string {
    const hashed = createHmac('sha256', this.secret).update(`${bucket}:${subject}`).digest('hex').slice(0, 32);
    return `${this.prefix}:${bucket}:${hashed}`;
  }
}
