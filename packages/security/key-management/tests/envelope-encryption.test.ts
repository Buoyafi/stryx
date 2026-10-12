import { describe, expect, it } from 'vitest';
import {
  decryptWithDek,
  encryptWithDek,
  generateDek,
  secureZero,
} from '../src/envelope-encryption.js';
import { DecryptionIntegrityError } from '../src/errors.js';

const scope = { walletId: 'wallet-1' };

describe('envelope encryption', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const dek = generateDek();
    const plaintext = Buffer.from('super-secret-private-key-bytes');

    const parts = encryptWithDek(plaintext, dek);
    const decrypted = decryptWithDek(parts, dek, scope);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('generates a unique IV on every call, even for the same DEK and plaintext', () => {
    const dek = generateDek();
    const plaintext = Buffer.from('same plaintext both times');

    const a = encryptWithDek(plaintext, dek);
    const b = encryptWithDek(plaintext, dek);

    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false); // GCM: different IV -> different ciphertext
  });

  it('throws DecryptionIntegrityError if ciphertext is tampered with', () => {
    const dek = generateDek();
    const parts = encryptWithDek(Buffer.from('hello'), dek);
    parts.ciphertext[0] = (parts.ciphertext[0] ?? 0) ^ 0xff; // flip a bit

    expect(() => decryptWithDek(parts, dek, scope)).toThrow(DecryptionIntegrityError);
  });

  it('throws DecryptionIntegrityError if the wrong DEK is used', () => {
    const dek = generateDek();
    const wrongDek = generateDek();
    const parts = encryptWithDek(Buffer.from('hello'), dek);

    expect(() => decryptWithDek(parts, wrongDek, scope)).toThrow(DecryptionIntegrityError);
  });

  it('secureZero overwrites buffer contents', () => {
    const buf = Buffer.from('sensitive-data');
    secureZero(buf);
    expect(buf.every((byte) => byte === 0)).toBe(true);
  });
});
