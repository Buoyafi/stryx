import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { DecryptionIntegrityError } from './errors.js';
import type { WalletKeyScope } from './types.js';

const ALGORITHM = 'aes-256-gcm';
const DEK_LENGTH_BYTES = 32; // 256-bit
const IV_LENGTH_BYTES = 12; // 96-bit, the GCM-recommended IV size

export interface CiphertextParts {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Generates a new random 256-bit DEK. Caller owns zeroing it after use. */
export function generateDek(): Buffer {
  return randomBytes(DEK_LENGTH_BYTES);
}

/** Encrypts arbitrary plaintext (a private key, in this package's usage) with a DEK. */
export function encryptWithDek(plaintext: Buffer, dek: Buffer): CiphertextParts {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/** Decrypts ciphertext produced by encryptWithDek. */
export function decryptWithDek(
  parts: CiphertextParts,
  dek: Buffer,
  scope: WalletKeyScope,
): Buffer {
  try {
    const decipher = createDecipheriv(ALGORITHM, dek, parts.iv);
    decipher.setAuthTag(parts.authTag);
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
  } catch {
    // node:crypto's generic error on a tag mismatch is replaced by our own typed one.
    throw new DecryptionIntegrityError(scope);
  }
}

/** Explicitly overwrites a buffer's contents with zeros before it's dropped. */
export function secureZero(buffer: Buffer): void {
  buffer.fill(0);
}
