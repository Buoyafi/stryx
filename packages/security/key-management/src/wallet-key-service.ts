import { decryptWithDek, encryptWithDek, generateDek, secureZero } from './envelope-encryption.js';
import { EncryptedPrivateKeyRecordSchema, WalletKeyScopeSchema } from './types.js';
import type {
  EncryptedPrivateKeyRecord,
  KeyManagementProvider,
  Logger,
  WalletKeyScope,
} from './types.js';

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Wallet private-key custody per ADR-001 §3.1–§3.4. Signing is a scoped callback: the raw key exists
 * only inside it and is zeroed when it returns or throws.
 */
export class WalletKeyService {
  constructor(
    private readonly kms: KeyManagementProvider,
    private readonly logger: Logger = noopLogger,
  ) {}

  /** Encrypts a freshly generated or imported private key for storage. */
  async encryptPrivateKeyForStorage(
    rawScope: WalletKeyScope,
    privateKey: Buffer,
  ): Promise<EncryptedPrivateKeyRecord> {
    const scope = WalletKeyScopeSchema.parse(rawScope);
    const dek = generateDek();

    try {
      const { ciphertext, iv, authTag } = encryptWithDek(privateKey, dek);
      const wrappedDek = await this.kms.wrapDek(dek);

      const record: EncryptedPrivateKeyRecord = {
        encryptedPrivateKey: ciphertext.toString('base64'),
        wrappedDek: wrappedDek.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        keyVersion: 1,
      };

      this.logger.info('wallet private key encrypted for storage', {
        walletId: scope.walletId,
        kmsKeyId: this.kms.keyId,
        keyVersion: record.keyVersion,
      });

      return EncryptedPrivateKeyRecordSchema.parse(record);
    } finally {
      secureZero(dek);
      secureZero(privateKey);
    }
  }

  /** The signing flow. `fn` receives the raw private key only while it runs: do nothing in it but sign (ADR-001 §3.2). */
  async withDecryptedPrivateKey<T>(
    rawScope: WalletKeyScope,
    record: EncryptedPrivateKeyRecord,
    fn: (privateKey: Buffer) => Promise<T> | T,
  ): Promise<T> {
    const scope = WalletKeyScopeSchema.parse(rawScope);
    const parsed = EncryptedPrivateKeyRecordSchema.parse(record);

    const wrappedDek = Buffer.from(parsed.wrappedDek, 'base64');
    let dek: Buffer | undefined;
    let privateKey: Buffer | undefined;

    try {
      dek = await this.kms.unwrapDek(wrappedDek);
      privateKey = decryptWithDek(
        {
          ciphertext: Buffer.from(parsed.encryptedPrivateKey, 'base64'),
          iv: Buffer.from(parsed.iv, 'base64'),
          authTag: Buffer.from(parsed.authTag, 'base64'),
        },
        dek,
        scope,
      );

      return await fn(privateKey);
    } finally {
      // Zero both, whatever happened.
      if (dek) secureZero(dek);
      if (privateKey) secureZero(privateKey);
      this.logger.debug('key material zeroed post-signing', { walletId: scope.walletId });
    }
  }

  /**
   * Warms the KMS path for a wallet ahead of a time-critical signature: unwraps the DEK and zeroes it
   * at once. The private key is never decrypted.
   */
  async warmUnwrap(rawScope: WalletKeyScope, record: EncryptedPrivateKeyRecord): Promise<void> {
    const scope = WalletKeyScopeSchema.parse(rawScope);
    const parsed = EncryptedPrivateKeyRecordSchema.parse(record);
    let dek: Buffer | undefined;
    try {
      dek = await this.kms.unwrapDek(Buffer.from(parsed.wrappedDek, 'base64'));
    } finally {
      if (dek) secureZero(dek);
      this.logger.debug('kms warm unwrap done, DEK zeroed', { walletId: scope.walletId });
    }
  }

  /** Unwraps a wallet's data key and hands it to the caller, who must zero it (secureZero). */
  async unwrapDekForHold(rawScope: WalletKeyScope, record: EncryptedPrivateKeyRecord): Promise<Buffer> {
    const scope = WalletKeyScopeSchema.parse(rawScope);
    const parsed = EncryptedPrivateKeyRecordSchema.parse(record);
    const dek = await this.kms.unwrapDek(Buffer.from(parsed.wrappedDek, 'base64'));
    this.logger.debug('data key unwrapped and held for a pending signature', { walletId: scope.walletId });
    return dek;
  }

  /** withDecryptedPrivateKey with a data key the caller already holds: no KMS call. */
  async withPrivateKeyFromDek<T>(rawScope: WalletKeyScope, record: EncryptedPrivateKeyRecord, dek: Buffer, fn: (privateKey: Buffer) => Promise<T> | T): Promise<T> {
    const scope = WalletKeyScopeSchema.parse(rawScope);
    const parsed = EncryptedPrivateKeyRecordSchema.parse(record);
    let privateKey: Buffer | undefined;
    try {
      privateKey = decryptWithDek(
        {
          ciphertext: Buffer.from(parsed.encryptedPrivateKey, 'base64'),
          iv: Buffer.from(parsed.iv, 'base64'),
          authTag: Buffer.from(parsed.authTag, 'base64'),
        },
        dek,
        scope,
      );
      return await fn(privateKey);
    } finally {
      if (privateKey) secureZero(privateKey);
    }
  }

  /** Key rotation per ADR-001 §3.4: re-encrypt with a fresh DEK, wrap it, increment keyVersion. */
  async rotateKey(
    rawScope: WalletKeyScope,
    record: EncryptedPrivateKeyRecord,
  ): Promise<EncryptedPrivateKeyRecord> {
    const scope = WalletKeyScopeSchema.parse(rawScope);

    const rotated = await this.withDecryptedPrivateKey(scope, record, async (privateKey) => {
      const newDek = generateDek();
      try {
        const { ciphertext, iv, authTag } = encryptWithDek(privateKey, newDek);
        const wrappedDek = await this.kms.wrapDek(newDek);

        return EncryptedPrivateKeyRecordSchema.parse({
          encryptedPrivateKey: ciphertext.toString('base64'),
          wrappedDek: wrappedDek.toString('base64'),
          iv: iv.toString('base64'),
          authTag: authTag.toString('base64'),
          keyVersion: record.keyVersion + 1,
        });
      } finally {
        secureZero(newDek);
      }
    });

    this.logger.info('wallet key rotated', {
      walletId: scope.walletId,
      fromVersion: record.keyVersion,
      toVersion: rotated.keyVersion,
      kmsKeyId: this.kms.keyId,
    });

    return rotated;
  }

  /**
   * Moves a wallet's key to another KMS provider: unwraps with the current provider, wraps a fresh DEK
   * with `targetKms`, and verifies the target can unwrap it before returning. The caller must persist
   * the new record atomically.
   */
  async migrateToProvider(
    rawScope: WalletKeyScope,
    record: EncryptedPrivateKeyRecord,
    targetKms: Pick<KeyManagementProvider, 'wrapDek' | 'unwrapDek' | 'keyId'>,
  ): Promise<EncryptedPrivateKeyRecord> {
    const scope = WalletKeyScopeSchema.parse(rawScope);

    const migrated = await this.withDecryptedPrivateKey(scope, record, async (privateKey) => {
      const newDek = generateDek();
      try {
        const { ciphertext, iv, authTag } = encryptWithDek(privateKey, newDek);
        const wrappedDek = await targetKms.wrapDek(newDek);

        const roundTripped = await targetKms.unwrapDek(wrappedDek);
        if (!roundTripped.equals(newDek)) {
          throw new Error(
            `Migration verification failed for wallet=${scope.walletId}: the target KMS provider ` +
              `(keyId=${targetKms.keyId}) did not return the same DEK it was just given to wrap. ` +
              'Refusing to treat this migration as successful, nothing will be persisted.',
          );
        }

        return EncryptedPrivateKeyRecordSchema.parse({
          encryptedPrivateKey: ciphertext.toString('base64'),
          wrappedDek: wrappedDek.toString('base64'),
          iv: iv.toString('base64'),
          authTag: authTag.toString('base64'),
          keyVersion: record.keyVersion + 1,
        });
      } finally {
        secureZero(newDek);
      }
    });

    this.logger.info('wallet key migrated to new KMS provider', {
      walletId: scope.walletId,
      fromVersion: record.keyVersion,
      toVersion: migrated.keyVersion,
      targetKmsKeyId: targetKms.keyId,
    });

    return migrated;
  }
}
