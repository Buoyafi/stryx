export interface StepUpRedisClient {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/**
 * A short-lived "they just re-proved who they are" grant, keyed by user id, for actions where being
 * signed in is not enough. Not a session.
 */
export class StepUpStore {
  constructor(
    private readonly redis: StepUpRedisClient,
    private readonly keyPrefix = 'stepup',
    private readonly ttlSeconds = 300,
  ) {}

  async grant(userId: string): Promise<void> {
    await this.redis.set(this.key(userId), '1', 'EX', this.ttlSeconds);
  }

  async isGranted(userId: string): Promise<boolean> {
    return (await this.redis.get(this.key(userId))) !== null;
  }

  /** Uses the grant up, in one step: of several requests arriving together, exactly one gets true. */
  async consume(userId: string): Promise<boolean> {
    return (await this.redis.getdel(this.key(userId))) !== null;
  }

  async revoke(userId: string): Promise<void> {
    await this.redis.del(this.key(userId));
  }

  private key(userId: string): string {
    return `${this.keyPrefix}:${userId}`;
  }
}
