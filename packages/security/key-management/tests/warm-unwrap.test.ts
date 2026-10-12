import { describe, expect, it, vi } from 'vitest';
import * as envelope from '../src/envelope-encryption.js';
import { WalletKeyService } from '../src/wallet-key-service.js';
import { FakeKmsProvider } from './fakes/fake-kms-provider.js';

const scope = { walletId: 'wallet-warm' };

describe('WalletKeyService.warmUnwrap', () => {
  it('makes one KMS unwrap and never decrypts the private key', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);
    const record = await service.encryptPrivateKeyForStorage(scope, Buffer.from('key-material'));
    const decrypt = vi.spyOn(envelope, 'decryptWithDek');

    await service.warmUnwrap(scope, record);

    expect(kms.unwrapCallCount).toBe(1);
    expect(decrypt).not.toHaveBeenCalled();
    decrypt.mockRestore();
  });

  it('zeroes the unwrapped DEK before returning', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);
    const record = await service.encryptPrivateKeyForStorage(scope, Buffer.from('key-material'));
    let dek: Buffer | undefined;
    const original = kms.unwrapDek.bind(kms);
    kms.unwrapDek = async (wrapped: Buffer) => (dek = await original(wrapped));

    await service.warmUnwrap(scope, record);

    expect(dek).toBeDefined();
    expect(dek!.every((b) => b === 0)).toBe(true);
  });

  it('surfaces a KMS failure, so a broken key path shows up at warm-up', async () => {
    const kms = new FakeKmsProvider();
    const service = new WalletKeyService(kms);
    const record = await service.encryptPrivateKeyForStorage(scope, Buffer.from('key-material'));
    kms.shouldFailNextUnwrap = true;
    await expect(service.warmUnwrap(scope, record)).rejects.toThrow('simulated KMS outage');
  });
});
