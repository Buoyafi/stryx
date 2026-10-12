import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WalletKeyService } from '../src/wallet-key-service.js';
import { FakeKmsProvider } from './fakes/fake-kms-provider.js';

const scope = { walletId: 'wallet-abc' };

describe('WalletKeyService', () => {
  it('encrypts a private key for storage and can decrypt it back via the signing flow', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);
    const originalKey = Buffer.from('0xdeadbeef-fake-private-key-bytes');
    const originalKeyCopy = Buffer.from(originalKey); // preserve for comparison, since encrypt zeroes the input

    const record = await service.encryptPrivateKeyForStorage(scope, originalKey);

    expect(record.keyVersion).toBe(1);
    expect(record.encryptedPrivateKey).not.toEqual(originalKeyCopy.toString('base64'));

    const recovered = await service.withDecryptedPrivateKey(scope, record, (privateKey) =>
      Buffer.from(privateKey), // copy it out, since the original gets zeroed after this callback
    );

    expect(recovered.equals(originalKeyCopy)).toBe(true);
  });

  it('zeroes the caller-supplied buffer after encryptPrivateKeyForStorage', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);
    const key = Buffer.from('sensitive-key-material-here');

    await service.encryptPrivateKeyForStorage(scope, key);

    expect(key.every((byte) => byte === 0)).toBe(true);
  });

  it('zeroes the raw private key buffer after the signing callback returns', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);
    const record = await service.encryptPrivateKeyForStorage(scope, Buffer.from('key-material'));

    let capturedRef: Buffer | undefined;
    await service.withDecryptedPrivateKey(scope, record, (privateKey) => {
      capturedRef = privateKey; // simulate a caller holding onto the reference (they shouldn't, but verify we still zero it)
    });

    expect(capturedRef).toBeDefined();
    expect(capturedRef!.every((byte) => byte === 0)).toBe(true);
  });

  it('zeroes key material even when the signing callback throws', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);
    const record = await service.encryptPrivateKeyForStorage(scope, Buffer.from('key-material'));

    let capturedRef: Buffer | undefined;
    await expect(
      service.withDecryptedPrivateKey(scope, record, (privateKey) => {
        capturedRef = privateKey;
        throw new Error('signing failed');
      }),
    ).rejects.toThrow('signing failed');

    expect(capturedRef!.every((byte) => byte === 0)).toBe(true);
  });

  it('propagates a KMS outage without partially succeeding', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);
    const record = await service.encryptPrivateKeyForStorage(scope, Buffer.from('key-material'));

    kms.shouldFailNextUnwrap = true;

    await expect(
      service.withDecryptedPrivateKey(scope, record, () => {
        throw new Error('should never reach the callback');
      }),
    ).rejects.toThrow('simulated KMS outage');
  });

  it('rotates a key: new ciphertext, new wrapped DEK, incremented version, same recoverable plaintext', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);
    const original = Buffer.from('rotate-me-please');
    const originalCopy = Buffer.from(original);

    const v1 = await service.encryptPrivateKeyForStorage(scope, original);
    const v2 = await service.rotateKey(scope, v1);

    expect(v2.keyVersion).toBe(2);
    expect(v2.encryptedPrivateKey).not.toEqual(v1.encryptedPrivateKey);
    expect(v2.wrappedDek).not.toEqual(v1.wrappedDek);
    expect(v2.iv).not.toEqual(v1.iv);

    const recovered = await service.withDecryptedPrivateKey(scope, v2, (privateKey) =>
      Buffer.from(privateKey),
    );
    expect(recovered.equals(originalCopy)).toBe(true);

    // Old record (v1) should still be independently decryptable until the caller atomically swaps it
    // out: rotation doesn't invalidate v1 itself.
    const recoveredFromV1 = await service.withDecryptedPrivateKey(scope, v1, (privateKey) =>
      Buffer.from(privateKey),
    );
    expect(recoveredFromV1.equals(originalCopy)).toBe(true);
  });

  it('validates malformed scope and record input via zod', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);

    await expect(
      service.encryptPrivateKeyForStorage({ walletId: '' }, Buffer.from('x')),
    ).rejects.toThrow();
  });

  describe('migrateToProvider (ADR-002 §3.9: cross-provider migration)', () => {
    it('unwraps with the OLD (currently-configured) provider and wraps with the NEW one', async () => {
      const oldKms = new FakeKmsProvider();
      const newKms = new FakeKmsProvider();
      const service = new WalletKeyService(oldKms); // configured with the OLD provider, same as a real migration

      const original = Buffer.from('migrate-me-please');
      const originalCopy = Buffer.from(original);
      const v1 = await service.encryptPrivateKeyForStorage(scope, original);

      const migrated = await service.migrateToProvider(scope, v1, newKms);

      expect(migrated.keyVersion).toBe(2);
      expect(oldKms.unwrapCallCount).toBe(1); // read the OLD record via the OLD provider
      expect(newKms.wrapCallCount).toBe(1); // wrote the NEW record via the NEW provider
      expect(oldKms.wrapCallCount).toBe(1); // only from encryptPrivateKeyForStorage's initial write, not from migration
      expect(newKms.unwrapCallCount).toBe(1); // migration verifies the new DEK round-trips before returning

      // Recoverable through the new provider: a separate decrypt, proving the returned record is
      // usable.
      const serviceOnNewProvider = new WalletKeyService(newKms);
      const recovered = await serviceOnNewProvider.withDecryptedPrivateKey(scope, migrated, (pk) => Buffer.from(pk));
      expect(recovered.equals(originalCopy)).toBe(true);
    });

    it('the migrated record is NOT decryptable via the OLD provider (the whole point of migrating)', async () => {
      const oldKms = new FakeKmsProvider();
      const newKms = new FakeKmsProvider();
      const service = new WalletKeyService(oldKms);

      const v1 = await service.encryptPrivateKeyForStorage(scope, Buffer.from('some-key-bytes-here'));
      const migrated = await service.migrateToProvider(scope, v1, newKms);

      // A wrapped key from the new provider is meaningless to the old one: unwrapping must fail.
      await expect(
        service.withDecryptedPrivateKey(scope, migrated, (pk) => pk),
      ).rejects.toThrow();
    });

    it('the OLD record (v1) is untouched and still independently decryptable via the OLD provider', async () => {
      const oldKms = new FakeKmsProvider();
      const newKms = new FakeKmsProvider();
      const service = new WalletKeyService(oldKms);

      const original = Buffer.from('untouched-original');
      const originalCopy = Buffer.from(original);
      const v1 = await service.encryptPrivateKeyForStorage(scope, original);

      await service.migrateToProvider(scope, v1, newKms);

      const recoveredFromV1 = await service.withDecryptedPrivateKey(scope, v1, (pk) => Buffer.from(pk));
      expect(recoveredFromV1.equals(originalCopy)).toBe(true);
    });

    it('propagates a failure from the OLD provider (unwrap) without ever calling the new provider', async () => {
      const oldKms = new FakeKmsProvider();
      const newKms = new FakeKmsProvider();
      const service = new WalletKeyService(oldKms);
      const v1 = await service.encryptPrivateKeyForStorage(scope, Buffer.from('key-bytes'));

      oldKms.shouldFailNextUnwrap = true;

      await expect(service.migrateToProvider(scope, v1, newKms)).rejects.toThrow('simulated KMS outage');
      expect(newKms.wrapCallCount).toBe(0); // never reached the new provider
    });

    it('propagates a failure from the NEW provider (wrap): old record remains the only valid one', async () => {
      const oldKms = new FakeKmsProvider();
      const failingNewKms = {
        keyId: 'failing-new-kms',
        async wrapDek(): Promise<Buffer> {
          throw new Error('simulated new-provider outage');
        },
        async unwrapDek(): Promise<Buffer> {
          throw new Error('should never be called');
        },
      };
      const service = new WalletKeyService(oldKms);
      const original = Buffer.from('key-bytes-here');
      const originalCopy = Buffer.from(original);
      const v1 = await service.encryptPrivateKeyForStorage(scope, original);

      await expect(service.migrateToProvider(scope, v1, failingNewKms)).rejects.toThrow(
        'simulated new-provider outage',
      );

      // v1 is completely unaffected by the failed migration attempt.
      const recovered = await service.withDecryptedPrivateKey(scope, v1, (pk) => Buffer.from(pk));
      expect(recovered.equals(originalCopy)).toBe(true);
    });

    it('refuses to treat a migration as successful if the target provider does not round-trip the exact DEK it wrapped', async () => {
      const oldKms = new FakeKmsProvider();
      // A provider that lies: wrapDek succeeds, but unwrapping returns different bytes.
      const corruptingNewKms = {
        keyId: 'corrupting-new-kms',
        async wrapDek(dek: Buffer): Promise<Buffer> {
          return Buffer.from(dek);
        },
        async unwrapDek(): Promise<Buffer> {
          return randomBytes(32); // wrong bytes back, not the dek it was given
        },
      };
      const service = new WalletKeyService(oldKms);
      const original = Buffer.from('key-bytes-here-32-bytes-long!!!!');
      const originalCopy = Buffer.from(original);
      const v1 = await service.encryptPrivateKeyForStorage(scope, original);

      await expect(service.migrateToProvider(scope, v1, corruptingNewKms)).rejects.toThrow(/verification failed/i);

      // Nothing about v1 changed: this method never touches persistence, and the caller (the migration
      // script) never sees a record to write.
      const recovered = await service.withDecryptedPrivateKey(scope, v1, (pk) => Buffer.from(pk));
      expect(recovered.equals(originalCopy)).toBe(true);
    });
  });
});
