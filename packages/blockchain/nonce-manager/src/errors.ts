import type { NonceScope } from './types.js';

export class NonceManagerError extends Error {
  public readonly scope: NonceScope;

  constructor(message: string, scope: NonceScope) {
    super(message);
    this.name = new.target.name;
    this.scope = scope;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when allocate() is called before the counter has ever been initialized from chain state. */
export class NonceStoreNotInitializedError extends NonceManagerError {
  constructor(scope: NonceScope) {
    super(
      `Nonce store not initialized for chain=${scope.chainId} wallet=${scope.walletAddress}. Call initialize() first.`,
      scope,
    );
  }
}

/** Thrown when the init lock could not be acquired within the configured retry budget. */
export class NonceLockTimeoutError extends NonceManagerError {
  constructor(scope: NonceScope) {
    super(
      `Timed out acquiring init lock for chain=${scope.chainId} wallet=${scope.walletAddress}. Another process may be stuck holding it.`,
      scope,
    );
  }
}

/** Thrown when releaseNonce() is called with a nonce that was never allocated, or already reused. */
export class InvalidNonceReleaseError extends NonceManagerError {
  constructor(scope: NonceScope, nonce: number) {
    super(
      `Cannot release nonce=${nonce} for chain=${scope.chainId} wallet=${scope.walletAddress}: it was never allocated or has already been consumed.`,
      scope,
    );
  }
}

/** Thrown when on-chain state and the Redis counter have diverged in a way that requires operator attention. */
export class NonceReconciliationError extends NonceManagerError {
  public readonly localNext: number;
  public readonly chainPending: number;

  constructor(scope: NonceScope, localNext: number, chainPending: number) {
    super(
      `Nonce drift detected for chain=${scope.chainId} wallet=${scope.walletAddress}: ` +
        `local next=${localNext}, chain pending=${chainPending}. Chain is ahead of local state, ` +
        `which should be impossible unless Redis lost data or another process bypassed this manager.`,
      scope,
    );
    this.localNext = localNext;
    this.chainPending = chainPending;
  }
}
