import { KmsOperationError } from './errors.js';
import type { KeyManagementProvider } from './types.js';

/** The minimal subset of the AWS SDK v3 KMSClient this package needs. */
export interface MinimalKmsClient {
  send(command: { input: unknown }): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array }>;
}

export interface AwsKmsCommandFactory {
  encryptCommand(keyId: string, plaintext: Buffer): { input: unknown };
  decryptCommand(keyId: string, ciphertext: Buffer): { input: unknown };
}

/** KeyManagementProvider backed by a real AWS KMS key. */
export class AwsKeyManagementProvider implements KeyManagementProvider {
  constructor(
    private readonly client: MinimalKmsClient,
    private readonly commands: AwsKmsCommandFactory,
    public readonly keyId: string,
  ) {}

  async wrapDek(dek: Buffer): Promise<Buffer> {
    try {
      const result = await this.client.send(this.commands.encryptCommand(this.keyId, dek));
      if (!result.CiphertextBlob) {
        throw new Error('KMS Encrypt response missing CiphertextBlob');
      }
      return Buffer.from(result.CiphertextBlob);
    } catch (cause) {
      throw new KmsOperationError('wrap', cause);
    }
  }

  async unwrapDek(wrappedDek: Buffer): Promise<Buffer> {
    try {
      const result = await this.client.send(this.commands.decryptCommand(this.keyId, wrappedDek));
      if (!result.Plaintext) {
        throw new Error('KMS Decrypt response missing Plaintext');
      }
      return Buffer.from(result.Plaintext);
    } catch (cause) {
      throw new KmsOperationError('unwrap', cause);
    }
  }
}
