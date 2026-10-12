/** The minimal Redis surface this needs; a real ioredis instance satisfies it. */
export interface EmergencyStopRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Checks and sets the `emergency_stop:{scope}` Redis flag from ADR-001 §3.5. */
export class EmergencyStopGuard {
  constructor(
    private readonly redis: EmergencyStopRedisClient,
    private readonly keyPrefix = 'emergency_stop',
  ) {}

  async isStopped(walletId: string, ownerId: string): Promise<boolean> {
    const [globalFlag, walletFlag, userFlag] = await Promise.all([
      this.redis.get(this.globalKey()),
      this.redis.get(this.walletKey(walletId)),
      this.redis.get(this.userKey(ownerId)),
    ]);
    return globalFlag !== null || walletFlag !== null || userFlag !== null;
  }

  async triggerGlobalStop(reason: string): Promise<void> {
    await this.redis.set(this.globalKey(), reason);
  }

  async triggerWalletStop(walletId: string, reason: string): Promise<void> {
    await this.redis.set(this.walletKey(walletId), reason);
  }

  async triggerUserStop(userId: string, reason: string): Promise<void> {
    await this.redis.set(this.userKey(userId), reason);
  }

  async clearGlobalStop(): Promise<void> {
    await this.redis.del(this.globalKey());
  }

  async clearWalletStop(walletId: string): Promise<void> {
    await this.redis.del(this.walletKey(walletId));
  }

  async clearUserStop(userId: string): Promise<void> {
    await this.redis.del(this.userKey(userId));
  }

  private globalKey(): string {
    return `${this.keyPrefix}:global`;
  }

  private walletKey(walletId: string): string {
    return `${this.keyPrefix}:wallet:${walletId}`;
  }

  private userKey(userId: string): string {
    return `${this.keyPrefix}:user:${userId}`;
  }
}
