import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { LocalKmsUsedInProductionError } from './errors.js';
import type { KeyManagementProvider } from './types.js';

/**
 * A fake KMS that keeps its KEK in process memory, for local development and CI only. It does not meet
 * the ADR-001 threat model, and refuses to construct in production.
 */
export class LocalKeyManagementProvider implements KeyManagementProvider {
  public readonly keyId = 'local-dev-kek';
  private readonly kek: Buffer;

  constructor() {
    if (process.env['NODE_ENV'] === 'production') {
      throw new LocalKmsUsedInProductionError();
    }

    // The KEK must be stable across restarts, or every stored wallet becomes undecryptable.
    const provided = process.env['LOCAL_KMS_KEK'];
    if (!provided) {
      throw new Error(
        'LOCAL_KMS_KEK is not set. The local dev key provider needs a stable 32-byte hex key, or wallets ' +
          'become undecryptable after every restart. Generate one with `openssl rand -hex 32` and set ' +
          'LOCAL_KMS_KEK in your environment. Treat it like a secret: anything encrypted under it is only ' +
          'recoverable while you still have it.',
      );
    }

    const kek = Buffer.from(provided, 'hex');
    if (kek.length !== 32) {
      throw new Error(`LOCAL_KMS_KEK must be exactly 32 bytes (64 hex chars); got ${kek.length} bytes.`);
    }
    this.kek = kek;
  }

  async wrapDek(dek: Buffer): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Pack iv + authTag + ciphertext together since this fake has no separate metadata store the way a
    // real KMS API response would.
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  async unwrapDek(wrappedDek: Buffer): Promise<Buffer> {
    const iv = wrappedDek.subarray(0, 12);
    const authTag = wrappedDek.subarray(12, 28);
    const ciphertext = wrappedDek.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
