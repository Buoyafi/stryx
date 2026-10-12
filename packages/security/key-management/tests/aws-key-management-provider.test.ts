import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AwsKeyManagementProvider, type MinimalKmsClient, type AwsKmsCommandFactory } from '../src/aws-key-management-provider.js';
import { KmsOperationError } from '../src/errors.js';
import { WalletKeyService } from '../src/wallet-key-service.js';

/** ADR-002 §3.8: this class was wired into apps/api/src/kms-provider.ts but had ZERO test coverage before this file. */

const fakeCommands: AwsKmsCommandFactory = {
  encryptCommand: (keyId, plaintext) => ({ input: { op: 'encrypt', keyId, plaintext } }),
  decryptCommand: (keyId, ciphertext) => ({ input: { op: 'decrypt', keyId, ciphertext } }),
};

describe('AwsKeyManagementProvider', () => {
  it('exposes the configured keyId, for audit correlation (ADR-001 §3.3)', () => {
    const client: MinimalKmsClient = { send: async () => ({}) };
    const provider = new AwsKeyManagementProvider(client, fakeCommands, 'arn:aws:kms:us-east-1:123:key/abc');
    expect(provider.keyId).toBe('arn:aws:kms:us-east-1:123:key/abc');
  });

  describe('wrapDek', () => {
    it('sends an encryptCommand for this keyId and returns the CiphertextBlob as a Buffer', async () => {
      const seen: unknown[] = [];
      const client: MinimalKmsClient = {
        send: async (command) => {
          seen.push(command);
          return { CiphertextBlob: new Uint8Array([1, 2, 3, 4]) };
        },
      };
      const provider = new AwsKeyManagementProvider(client, fakeCommands, 'my-key');

      const result = await provider.wrapDek(Buffer.from('dek-bytes'));

      expect(result).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(seen).toEqual([{ input: { op: 'encrypt', keyId: 'my-key', plaintext: Buffer.from('dek-bytes') } }]);
    });

    it('wraps a missing CiphertextBlob in KmsOperationError, not a raw error', async () => {
      const client: MinimalKmsClient = { send: async () => ({}) }; // no CiphertextBlob
      const provider = new AwsKeyManagementProvider(client, fakeCommands, 'my-key');

      await expect(provider.wrapDek(Buffer.from('dek'))).rejects.toThrow(KmsOperationError);
    });

    it('wraps a client-level failure (throttling, network, IAM denial) in KmsOperationError', async () => {
      const client: MinimalKmsClient = {
        send: async () => {
          throw new Error('AccessDeniedException: not authorized to perform kms:Encrypt');
        },
      };
      const provider = new AwsKeyManagementProvider(client, fakeCommands, 'my-key');

      const err = await provider.wrapDek(Buffer.from('dek')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KmsOperationError);
      expect((err as Error).message).toContain('wrap');
      expect((err as Error).message).toContain('AccessDeniedException');
    });
  });

  describe('unwrapDek', () => {
    it('sends a decryptCommand for this keyId and returns the Plaintext as a Buffer', async () => {
      const seen: unknown[] = [];
      const client: MinimalKmsClient = {
        send: async (command) => {
          seen.push(command);
          return { Plaintext: new Uint8Array([9, 9, 9]) };
        },
      };
      const provider = new AwsKeyManagementProvider(client, fakeCommands, 'my-key');

      const result = await provider.unwrapDek(Buffer.from('wrapped-dek'));

      expect(result).toEqual(Buffer.from([9, 9, 9]));
      expect(seen).toEqual([{ input: { op: 'decrypt', keyId: 'my-key', ciphertext: Buffer.from('wrapped-dek') } }]);
    });

    it('wraps a missing Plaintext in KmsOperationError, not a raw error', async () => {
      const client: MinimalKmsClient = { send: async () => ({}) }; // no Plaintext
      const provider = new AwsKeyManagementProvider(client, fakeCommands, 'my-key');

      await expect(provider.unwrapDek(Buffer.from('wrapped'))).rejects.toThrow(KmsOperationError);
    });

    it('wraps a client-level failure in KmsOperationError', async () => {
      const client: MinimalKmsClient = {
        send: async () => {
          throw new Error('KMSInvalidStateException: key is pending deletion');
        },
      };
      const provider = new AwsKeyManagementProvider(client, fakeCommands, 'my-key');

      const err = await provider.unwrapDek(Buffer.from('wrapped')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KmsOperationError);
      expect((err as Error).message).toContain('unwrap');
      expect((err as Error).message).toContain('pending deletion');
    });
  });

  it('round-trips through a fake that actually encodes/decodes (closer to real KMS behavior than a canned response)', async () => {
    // A slightly more realistic fake: "encrypts" by reversing bytes, so wrap/unwrap must actually
    // compose correctly, not just pass through a fixed fixture.
    const client: MinimalKmsClient = {
      send: async (command) => {
        const input = (command as { input: { op: string; plaintext?: Buffer; ciphertext?: Buffer } }).input;
        if (input.op === 'encrypt') return { CiphertextBlob: Uint8Array.from(input.plaintext!).reverse() };
        return { Plaintext: Uint8Array.from(input.ciphertext!).reverse() };
      },
    };
    const provider = new AwsKeyManagementProvider(client, fakeCommands, 'my-key');

    const dek = Buffer.from('a-32-byte-dek-worth-of-bytes!!!!');
    const wrapped = await provider.wrapDek(dek);
    const unwrapped = await provider.unwrapDek(wrapped);

    expect(unwrapped.equals(dek)).toBe(true);
  });
});

describe('WalletKeyService.rotateKey backed by AwsKeyManagementProvider specifically', () => {
  // ADR-002 §3.8: rotation exercised against the class that runs in production.
  function makeRealisticAwsClient(): MinimalKmsClient {
    const kek = randomBytes(32); // stands in for the real KMS-held KEK
    return {
      async send(command) {
        const input = (command as { input: { op: 'encrypt' | 'decrypt'; plaintext?: Buffer; ciphertext?: Buffer } })
          .input;
        if (input.op === 'encrypt') {
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', kek, iv);
          const ciphertext = Buffer.concat([cipher.update(input.plaintext!), cipher.final()]);
          return { CiphertextBlob: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]) };
        }
        const blob = input.ciphertext!;
        const decipher = createDecipheriv('aes-256-gcm', kek, blob.subarray(0, 12));
        decipher.setAuthTag(blob.subarray(12, 28));
        return { Plaintext: Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]) };
      },
    };
  }

  it('rotates end to end (new wrapped DEK, incremented version, same recoverable plaintext)', async () => {
    const provider = new AwsKeyManagementProvider(makeRealisticAwsClient(), fakeCommands, 'prod-key-arn');
    const service = new WalletKeyService(provider);
    const scope = { walletId: 'wallet-for-rotation-test' };

    const original = Buffer.from('rotate-me-through-aws-provider!');
    const originalCopy = Buffer.from(original);

    const v1 = await service.encryptPrivateKeyForStorage(scope, original);
    const v2 = await service.rotateKey(scope, v1);

    expect(v2.keyVersion).toBe(2);
    expect(v2.wrappedDek).not.toEqual(v1.wrappedDek);
    expect(v2.encryptedPrivateKey).not.toEqual(v1.encryptedPrivateKey);

    const recovered = await service.withDecryptedPrivateKey(scope, v2, (pk) => Buffer.from(pk));
    expect(recovered.equals(originalCopy)).toBe(true);
  });
});
