import { noopLogger, type Logger } from '@stryx/logger';
import type { MintedNftEntry, MintedNftRecord, NftLedgerRepository, NftStandard } from './nft-ledger-repository.js';
import { chainErrorText } from './chain-error-text.js';

/** Thin wrapper over NftLedgerRepository: writes every token one mint produced in one batch, and logs. */
export class NftLedgerService {
  constructor(
    private readonly repository: NftLedgerRepository,
    private readonly logger: Logger = noopLogger,
  ) {}

  async recordMint(
    base: { walletId: string; ownerId: string; chainId: number; contract: string; standard: NftStandard },
    tokens: readonly { tokenId: string; amount: string }[],
  ): Promise<void> {
    for (const token of tokens) {
      const entry: MintedNftEntry = { ...base, tokenId: token.tokenId, amount: token.amount };
      await this.repository.create(entry);
    }
    this.logger.info('minted nft(s) recorded', {
      walletId: base.walletId,
      chainId: base.chainId,
      contract: base.contract,
      count: tokens.length,
    });
  }

  listHeld(walletId: string, chainId: number): Promise<MintedNftRecord[]> {
    return this.repository.listHeld(walletId, chainId);
  }

  listReceived(address: string, chainId: number): Promise<MintedNftRecord[]> {
    return this.repository.listReceived(address, chainId);
  }

  async markTransferred(
    target: { chainId: number; contract: string; tokenId: string; walletId: string },
    transferredTo: string,
  ): Promise<void> {
    await this.repository.markTransferred(target, transferredTo);
  }

  /** The text is shown on the mint page and kept: no RPC address (and so no provider key) in it, and short. */
  async recordDrainFailure(target: { chainId: number; contract: string; tokenId: string; walletId: string }, error: string): Promise<void> {
    await this.repository.recordDrainFailure(target, chainErrorText(error));
  }

  findLatestDrainFailure(ownerId: string, chainId: number): Promise<MintedNftRecord | null> {
    return this.repository.findLatestDrainFailure(ownerId, chainId);
  }
}
