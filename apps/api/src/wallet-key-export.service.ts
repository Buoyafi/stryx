import type { WalletKeyService } from '@stryx/key-management';
import type { WalletService, UserId } from '@stryx/wallet-service';
import type { WalletKeyRecordProvider } from '@stryx/transaction-engine';

export class WalletKeyExportService {
  constructor(
    private readonly walletService: WalletService,
    private readonly walletKeyService: WalletKeyService,
    private readonly recordProvider: WalletKeyRecordProvider,
  ) {}

  /** Ownership-checked first (throws WalletNotFoundError), then the same decrypt path signing uses. */
  async exportKey(ownerId: UserId, walletId: string): Promise<{ address: string; privateKey: `0x${string}` }> {
    const wallet = await this.walletService.getWalletSummary(ownerId, walletId);
    const record = await this.recordProvider.getRecord(walletId);
    const privateKey = await this.walletKeyService.withDecryptedPrivateKey({ walletId }, record, (buf) => `0x${buf.toString('hex')}` as `0x${string}`);
    return { address: wallet.address, privateKey };
  }
}
