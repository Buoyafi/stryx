import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { AwsKeyManagementProvider, LocalKeyManagementProvider, type KeyManagementProvider } from '@stryx/key-management';
import type { AppConfig } from '@stryx/config';

export function createKeyManagementProvider(config: AppConfig): KeyManagementProvider {
  if (config.KMS_PROVIDER === 'local') {
    return new LocalKeyManagementProvider();
  }

  const keyId = config.KMS_KEY_ID as string;
  const client = new KMSClient({});

  return new AwsKeyManagementProvider(
    client,
    {
      encryptCommand: (kid, plaintext) => new EncryptCommand({ KeyId: kid, Plaintext: plaintext }),
      decryptCommand: (kid, ciphertext) => new DecryptCommand({ KeyId: kid, CiphertextBlob: ciphertext }),
    },
    keyId,
  );
}
