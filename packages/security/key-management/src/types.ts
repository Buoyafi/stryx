import { z } from 'zod';

/** What Postgres stores for a wallet's private key, per ADR-001 §3.1. */
export const EncryptedPrivateKeyRecordSchema = z.object({
  /** AES-256-GCM ciphertext of the raw private key, base64. */
  encryptedPrivateKey: z.string().min(1),
  /** The wallet's DEK, wrapped (encrypted) by the KMS-held KEK, base64. */
  wrappedDek: z.string().min(1),
  /** Unique IV used for the private-key encryption operation, base64. */
  iv: z.string().min(1),
  /** GCM auth tag for the private-key ciphertext, base64: detects tampering. */
  authTag: z.string().min(1),
  /** Increments on every rotation. Present from day one per ADR-001 §3.4. */
  keyVersion: z.number().int().positive(),
});
export type EncryptedPrivateKeyRecord = z.infer<typeof EncryptedPrivateKeyRecordSchema>;

export const WalletKeyScopeSchema = z.object({
  walletId: z.string().min(1),
});
export type WalletKeyScope = z.infer<typeof WalletKeyScopeSchema>;

/** The abstraction over a KMS (AWS KMS, GCP Cloud KMS, Vault Transit) that ADR-001 §3.1 requires. */
export interface KeyManagementProvider {
  /** Encrypts (wraps) a DEK using the KMS-held KEK. Returns the wrapped DEK. */
  wrapDek(dek: Buffer): Promise<Buffer>;
  /** Decrypts (unwraps) a wrapped DEK using the KMS-held KEK. Returns the raw DEK. */
  unwrapDek(wrappedDek: Buffer): Promise<Buffer>;
  /** Identifies which KEK this provider is configured against, for audit logging. */
  readonly keyId: string;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
