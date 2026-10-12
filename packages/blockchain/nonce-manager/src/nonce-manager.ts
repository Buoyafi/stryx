import {
  InvalidNonceReleaseError,
  NonceLockTimeoutError,
  NonceReconciliationError,
} from './errors.js';
import { RedisNonceStore } from './redis-nonce-store.js';
import {
  NonceScopeSchema,
  NonceValueSchema,
  type ChainNonceReader,
  type Logger,
  type NonceManagerConfig,
  type NonceRedisClient,
  type NonceScope,
} from './types.js';

// A waiter outlasts the lock (60 x 100ms against a 5s TTL), so it either finds the counter or takes
// over.
const DEFAULT_CONFIG: Required<NonceManagerConfig> = {
  keyPrefix: 'nonce',
  initLockTtlMs: 5_000,
  initLockRetries: 60,
  initLockRetryDelayMs: 100,
  quietMs: 120_000,
  now: Date.now,
};

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Owns nonce allocation for every wallet across every chain. */
export class NonceManager {
  private readonly store: RedisNonceStore;
  private readonly config: Required<NonceManagerConfig>;
  private readonly logger: Logger;

  constructor(
    redis: NonceRedisClient,
    private readonly chainNonceReader: ChainNonceReader,
    config: NonceManagerConfig = {},
    logger: Logger = noopLogger,
  ) {
    this.store = new RedisNonceStore(redis, config.keyPrefix ?? DEFAULT_CONFIG.keyPrefix);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /** Allocates the next nonce to use for a transaction on this wallet/chain. */
  async getNextNonce(rawScope: NonceScope): Promise<number> {
    const scope = NonceScopeSchema.parse(rawScope);

    // Marked active BEFORE the counter moves, so healIfAhead can never pull back a nonce that was
    // handed out a moment ago.
    await this.touch(scope);

    let allocated = await this.store.allocate(scope);
    if (allocated !== null) {
      this.logger.debug('nonce allocated', { ...scope, nonce: allocated });
      return NonceValueSchema.parse(allocated);
    }

    // Not initialized yet: seed from the chain under a lock, so concurrent first callers do not each
    // seed.
    await this.initializeFromChain(scope);

    allocated = await this.store.allocate(scope);
    if (allocated === null) {
      // Should be unreachable: we just initialized.
      throw new NonceLockTimeoutError(scope);
    }

    this.logger.info('nonce allocated after cold-start init', { ...scope, nonce: allocated });
    return NonceValueSchema.parse(allocated);
  }

  /** A failed marker write must not fail a send: the worst case is one healIfAhead that acts too early. */
  private async touch(scope: NonceScope): Promise<void> {
    await this.store.touch(scope, this.config.now(), this.config.quietMs * 2).catch((err: unknown) => {
      this.logger.warn('could not record nonce activity', { ...scope, err: err instanceof Error ? err.message : String(err) });
    });
  }

  /** Returns a nonce to the reuse pool. */
  async releaseNonce(rawScope: NonceScope, rawNonce: number): Promise<void> {
    const scope = NonceScopeSchema.parse(rawScope);
    const nonce = NonceValueSchema.parse(rawNonce);

    const released = await this.store.release(scope, nonce);
    if (!released) {
      throw new InvalidNonceReleaseError(scope, nonce);
    }
    this.logger.debug('nonce released for reuse', { ...scope, nonce });
  }

  /** Reconciles local state against the chain. */
  async resync(rawScope: NonceScope): Promise<{ localNext: number; chainPending: number; driftDetected: boolean }> {
    const scope = NonceScopeSchema.parse(rawScope);
    const chainPending = await this.chainNonceReader.getPendingNonce(scope);
    const localNext = (await this.store.getNext(scope)) ?? chainPending;

    if (chainPending > localNext) {
      throw new NonceReconciliationError(scope, localNext, chainPending);
    }

    return { localNext, chainPending, driftDetected: false };
  }

  /** Explicit, operator-invoked override after a NonceReconciliationError has been investigated. */
  async forceResyncToChain(rawScope: NonceScope): Promise<number> {
    const scope = NonceScopeSchema.parse(rawScope);
    const chainPending = await this.chainNonceReader.getPendingNonce(scope);
    await this.store.forceSet(scope, chainPending);
    this.logger.warn('nonce store force-resynced to chain state', { ...scope, chainPending });
    return chainPending;
  }

  /**
   * Catches the counter up when the chain is ahead of it (a transaction went out that this manager did
   * not count: sent from outside, or one it gave up on that landed anyway).
   */
  async catchUpToChain(rawScope: NonceScope): Promise<number> {
    const scope = NonceScopeSchema.parse(rawScope);
    const chainPending = await this.chainNonceReader.getPendingNonce(scope);
    await this.store.advanceTo(scope, chainPending);
    return chainPending;
  }

  /**
   * The opposite of catchUpToChain: pulls the counter BACK when it is ahead of the chain's pending
   * nonce and no nonce has been handed out for `quietMs`.
   */
  async healIfAhead(rawScope: NonceScope): Promise<{ from: number; to: number } | null> {
    const scope = NonceScopeSchema.parse(rawScope);
    const now = this.config.now();
    const last = await this.store.lastActive(scope);
    if (last !== null && now - last < this.config.quietMs) return null;
    const localNext = await this.store.getNext(scope);
    if (localNext === null) return null;

    const chainPending = await this.chainNonceReader.getPendingNonce(scope);
    if (localNext <= chainPending) return null;
    const from = await this.store.resetIfAhead(scope, chainPending, now, this.config.quietMs);
    if (from === null) return null;
    this.logger.warn('nonce counter was ahead of the chain with nothing pending; pulled back', { ...scope, from, to: chainPending });
    return { from, to: chainPending };
  }

  /** Pays a wallet's one-time cold-start chain read ahead of a send. */
  async ensureInitialized(rawScope: NonceScope): Promise<boolean> {
    const scope = NonceScopeSchema.parse(rawScope);
    if (await this.store.isInitialized(scope)) return false;
    await this.initializeFromChain(scope);
    return true;
  }

  private async initializeFromChain(scope: NonceScope): Promise<void> {
    for (let attempt = 0; attempt < this.config.initLockRetries; attempt++) {
      if (await this.store.isInitialized(scope)) {
        return;
      }

      const lockToken = await this.store.acquireInitLock(scope, this.config.initLockTtlMs);
      if (lockToken === null) {
        await delay(this.config.initLockRetryDelayMs);
        continue;
      }

      try {
        if (await this.store.isInitialized(scope)) {
          return; // Another process won the race between our check and our lock.
        }
        const chainPending = await this.chainNonceReader.getPendingNonce(scope);
        await this.store.initializeIfAbsent(scope, chainPending);
        this.logger.info('nonce store initialized from chain', { ...scope, chainPending });
        return;
      } finally {
        await this.store.releaseInitLock(scope, lockToken);
      }
    }

    throw new NonceLockTimeoutError(scope);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
