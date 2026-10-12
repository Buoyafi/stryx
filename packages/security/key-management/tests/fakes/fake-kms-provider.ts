import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyManagementProvider } from '../../src/types.js';

/** Behaves like a real KMS (an internal key that never leaves this class), in memory, and counts its calls. */
export class FakeKmsProvider implements KeyManagementProvider {
  public readonly keyId = 'fake-kms-key';
  public wrapCallCount = 0;
  public unwrapCallCount = 0;
  public shouldFailNextUnwrap = false;

  private readonly kek = randomBytes(32);

  async wrapDek(dek: Buffer): Promise<Buffer> {
    this.wrapCallCount++;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  async unwrapDek(wrappedDek: Buffer): Promise<Buffer> {
    this.unwrapCallCount++;
    if (this.shouldFailNextUnwrap) {
      this.shouldFailNextUnwrap = false;
      throw new Error('simulated KMS outage');
    }
    const iv = wrappedDek.subarray(0, 12);
    const authTag = wrappedDek.subarray(12, 28);
    const ciphertext = wrappedDek.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
