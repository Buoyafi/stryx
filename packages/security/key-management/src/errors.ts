import type { WalletKeyScope } from './types.js';

export class KeyManagementError extends Error {
  public readonly scope: WalletKeyScope;

  constructor(message: string, scope: WalletKeyScope) {
    super(message);
    this.name = new.target.name;
    this.scope = scope;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the GCM auth tag doesn't verify: ciphertext or IV was tampered with or corrupted. */
export class DecryptionIntegrityError extends KeyManagementError {
  constructor(scope: WalletKeyScope) {
    super(
      `Private key decryption failed integrity check for wallet=${scope.walletId}. ` +
        `The ciphertext, IV, or auth tag has been altered or corrupted. Refusing to proceed.`,
      scope,
    );
  }
}

/** Thrown when the configured KMS provider rejects a wrap/unwrap call. */
export class KmsOperationError extends Error {
  public readonly scope: WalletKeyScope | undefined;

  constructor(operation: 'wrap' | 'unwrap', cause: unknown, scope?: WalletKeyScope) {
    super(
      `KMS ${operation} operation failed${scope ? ` for wallet=${scope.walletId}` : ''}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = new.target.name;
    this.scope = scope;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown by LocalKeyManagementProvider if it's ever instantiated outside development. */
export class LocalKmsUsedInProductionError extends Error {
  constructor() {
    super(
      'LocalKeyManagementProvider was instantiated with NODE_ENV=production. This provider ' +
        'keeps the KEK in process memory and is for local development / tests ONLY: it does ' +
        'not meet the ADR-001 threat model. Use AwsKeyManagementProvider (or an equivalent real ' +
        'KMS-backed provider) in any deployed environment.',
    );
    this.name = new.target.name;
  }
}
