import type { WalletRepository } from '@stryx/wallet-service';
import type { EncryptedPrivateKeyRecord } from '@stryx/key-management';
import type { WalletKeyRecordProvider } from '@stryx/transaction-engine';

/** Bridges wallet-service's persistence to the narrow interface TransactionSigner needs. */
export class WalletKeyRecordProviderAdapter implements WalletKeyRecordProvider {
  constructor(private readonly walletRepository: WalletRepository) {}

  async getRecord(walletId: string): Promise<EncryptedPrivateKeyRecord> {
    // Deliberately not scoped by owner: see WalletRepository.getKeyMaterialForSigning.
    const record = await this.walletRepository.getKeyMaterialForSigning(walletId);
    if (!record) {
      throw new Error(`Wallet ${walletId} not found: cannot sign with a wallet that doesn't exist`);
    }
    return {
      encryptedPrivateKey: record.encryptedPrivateKey,
      wrappedDek: record.wrappedDek,
      iv: record.iv,
      authTag: record.authTag,
      keyVersion: record.keyVersion,
    };
  }
}
