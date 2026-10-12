import { randomBytes, createHash } from 'node:crypto';

/** The minimal Redis surface this needs; a real ioredis instance satisfies it. */
export interface SessionRedisClient {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  // The per-account index of sessions, so all of an account's sessions can be ended at once.
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

interface StoredSession {
  userId: string;
  issuedAt: number;
  /** This session's own lifetime when it is not the default (an admin's is shorter). */
  idleSeconds?: number;
  maxAgeMs?: number;
}

/** How long a session lasts: `idleSeconds` without use, and `maxAgeMs` from sign-in at most. */
export interface SessionLifetime {
  idleSeconds: number;
  maxAgeMs: number;
}

/** ADR-003 §4.10: an admin account's sessions end after 1 hour idle and 12 hours at most. */
export const ADMIN_SESSION_LIFETIME: SessionLifetime = { idleSeconds: 60 * 60, maxAgeMs: 12 * 60 * 60 * 1000 };

/** The lifetime for an account by its role: shorter for admins, the store's default for everyone else. */
export function lifetimeForRole(role: string): SessionLifetime | undefined {
  return role === 'ADMIN' ? ADMIN_SESSION_LIFETIME : undefined;
}

export interface SessionRecord {
  userId: string;
}

/** The longest any session can live; the per-account index is kept no longer. */
const INDEX_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Redis-backed sessions (ADR-002 §3.4): an opaque random token, stored only as its hash, with a
 * sliding expiry and an absolute cap.
 */
export class RedisSessionStore {
  constructor(
    private readonly redis: SessionRedisClient,
    private readonly keyPrefix = 'session',
    /** Sliding TTL refreshed on every successful resolve. */
    private readonly slidingTtlSeconds = 60 * 60 * 24 * 7, // 7 days
    /** Hard cap from issuance, regardless of activity: forces re-login eventually even for an active session. */
    private readonly absoluteMaxAgeMs = 1000 * 60 * 60 * 24 * 30, // 30 days
  ) {}

  /** Mints a new session for `userId` and returns the raw token. */
  async create(userId: string, lifetime?: SessionLifetime): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const record: StoredSession = { userId, issuedAt: Date.now(), ...(lifetime ? { idleSeconds: lifetime.idleSeconds, maxAgeMs: lifetime.maxAgeMs } : {}) };
    const hash = this.hash(token);
    await this.redis.set(`${this.keyPrefix}:${hash}`, JSON.stringify(record), 'EX', lifetime?.idleSeconds ?? this.slidingTtlSeconds);
    // Remember it under the account, so "sign out everywhere" and suspending can end every session.
    const index = this.indexKey(userId);
    await this.redis.sadd(index, hash);
    await this.redis.expire(index, Math.max(INDEX_TTL_SECONDS, Math.ceil(this.absoluteMaxAgeMs / 1000)));
    return token;
  }

  /** Resolves a raw token to its session, refreshing the sliding expiry. */
  async resolve(token: string): Promise<SessionRecord | null> {
    const key = this.key(token);
    const raw = await this.redis.get(key);
    if (!raw) return null;

    let stored: StoredSession;
    try {
      stored = JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }

    if (Date.now() - stored.issuedAt > (stored.maxAgeMs ?? this.absoluteMaxAgeMs)) {
      await this.redis.del(key);
      return null;
    }

    // A suspended account has no sessions, whenever they were made (see blockUser).
    if ((await this.redis.get(this.blockedKey(stored.userId))) !== null) {
      await this.redis.del(key);
      return null;
    }

    // Sliding expiry: a session in use does not expire.
    const refreshed = await this.redis.expire(key, stored.idleSeconds ?? this.slidingTtlSeconds);
    if (refreshed === 0) return null;
    return { userId: stored.userId };
  }

  /** Shuts an account out: every session it has, or gets, stops resolving until `unblockUser`. */
  async blockUser(userId: string): Promise<void> {
    await this.redis.set(this.blockedKey(userId), '1', 'EX', Math.max(INDEX_TTL_SECONDS, Math.ceil(this.absoluteMaxAgeMs / 1000)) + 86_400);
  }

  async unblockUser(userId: string): Promise<void> {
    await this.redis.del(this.blockedKey(userId));
  }

  /** Revokes one session immediately (logout, or incident response on one token). */
  async revoke(token: string): Promise<void> {
    const key = this.key(token);
    const raw = await this.redis.get(key);
    await this.redis.del(key);
    if (raw) {
      try {
        await this.redis.srem(this.indexKey((JSON.parse(raw) as StoredSession).userId), this.hash(token));
      } catch {
        // A malformed record has no index entry worth cleaning.
      }
    }
  }

  /** Ends every session an account has, on every device. */
  async revokeAllForUser(userId: string): Promise<number> {
    const index = this.indexKey(userId);
    const hashes = await this.redis.smembers(index);
    let live = 0;
    for (const hash of hashes) {
      const key = `${this.keyPrefix}:${hash}`;
      if ((await this.redis.get(key)) !== null) live++;
      await this.redis.del(key);
    }
    await this.redis.del(index);
    return live;
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private key(token: string): string {
    // The token is never the Redis key: a dump or scan would otherwise hand over usable tokens.
    return `${this.keyPrefix}:${this.hash(token)}`;
  }

  private indexKey(userId: string): string {
    return `${this.keyPrefix}-user:${userId}`;
  }

  private blockedKey(userId: string): string {
    return `${this.keyPrefix}-blocked:${userId}`;
  }
}
