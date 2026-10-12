/**
 * Paces requests to OpenSea's mint endpoint across every wallet in one signed-mint job: a concurrency
 * limit, plus one shared pause when OpenSea answers 429.
 */

/** The shared pause runs past the caller's deadline: there is no point waiting to ask. */
export class PausedPastDeadlineError extends Error {
  constructor() {
    super('rate-limit pause runs past the deadline');
    this.name = 'PausedPastDeadlineError';
  }
}

export interface LimiterOptions {
  maxConcurrent: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class OpenSeaRequestLimiter {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private pausedUntil = 0;
  private consecutive429 = 0;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: LimiterOptions) {
    this.baseBackoffMs = options.baseBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  /** Runs `fn` once a slot is free and any shared 429 pause has passed. */
  async run<T>(fn: () => Promise<T>, giveUpAt?: number): Promise<T> {
    await this.acquire();
    try {
      // Looped: another wallet's 429 can lengthen the pause while this one is sleeping.
      for (let wait = this.pausedUntil - this.now(); wait > 0; wait = this.pausedUntil - this.now()) {
        if (giveUpAt !== undefined && this.pausedUntil >= giveUpAt) throw new PausedPastDeadlineError();
        await this.sleep(wait);
      }
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Records a 429 and returns how long every caller will now wait before its next request. */
  recordRateLimited(retryAfterMs: number | null): number {
    this.consecutive429++;
    const exponential = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (this.consecutive429 - 1));
    const jittered = Math.round(exponential * (0.8 + this.random() * 0.4));
    const delay = Math.max(retryAfterMs ?? 0, jittered);
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + delay);
    return delay;
  }

  recordSuccess(): void {
    this.consecutive429 = 0;
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.options.maxConcurrent) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // The releasing caller handed its slot straight to us: inFlight was never decremented.
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.inFlight--;
  }
}
