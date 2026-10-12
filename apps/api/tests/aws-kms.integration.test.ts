import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { AwsKeyManagementProvider, KmsOperationError } from '@stryx/key-management';

/**
 * ADR-002 §3.8: an integration test against a real, disposable AWS KMS key. Skipped unless its
 * environment variables are set, so it is not part of the regular suite.
 */

const TEST_KEY_ID = process.env['AWS_KMS_INTEGRATION_TEST_KEY_ID'];

function makeProvider(keyId: string): AwsKeyManagementProvider {
  return new AwsKeyManagementProvider(
    new KMSClient({}),
    {
      encryptCommand: (kid, plaintext) => new EncryptCommand({ KeyId: kid, Plaintext: plaintext }),
      decryptCommand: (kid, ciphertext) => new DecryptCommand({ KeyId: kid, CiphertextBlob: ciphertext }),
    },
    keyId,
  );
}

describe.skipIf(!TEST_KEY_ID)('AwsKeyManagementProvider: live AWS KMS (ADR-002 §3.8 item 2)', () => {
  it('round-trips a real 32-byte DEK through the real KMS key', async () => {
    const provider = makeProvider(TEST_KEY_ID!);
    const dek = randomBytes(32);

    const wrapped = await provider.wrapDek(dek);
    expect(wrapped.length).toBeGreaterThan(0);
    expect(wrapped.equals(dek)).toBe(false); // sanity: it actually got transformed, not echoed

    const unwrapped = await provider.unwrapDek(wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it('fails as KmsOperationError, not a raw SDK error, against a key that does not exist', async () => {
    const provider = makeProvider('arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000');

    // Longer than the default 5s: a rejection over the real network is slow.
    await expect(provider.wrapDek(randomBytes(32))).rejects.toThrow(KmsOperationError);
  }, 20_000);
});
