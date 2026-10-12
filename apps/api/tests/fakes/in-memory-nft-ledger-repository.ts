import { randomUUID } from 'node:crypto';
import type { MintedNftEntry, MintedNftRecord, NftLedgerRepository } from '../../src/nft-ledger-repository.js';

export class InMemoryNftLedgerRepository implements NftLedgerRepository {
  readonly rows: MintedNftRecord[] = [];

  async create(entry: MintedNftEntry): Promise<void> {
    this.rows.push({ ...entry, id: randomUUID(), mintedAt: new Date(), transferredAt: null, transferredTo: null, drainError: null, drainFailedAt: null });
  }

  async listHeld(walletId: string, chainId: number): Promise<MintedNftRecord[]> {
    return this.rows.filter((r) => r.walletId === walletId && r.chainId === chainId && r.transferredAt === null);
  }

  async listReceived(address: string, chainId: number): Promise<MintedNftRecord[]> {
    return this.rows.filter((r) => r.chainId === chainId && r.transferredTo?.toLowerCase() === address.toLowerCase());
  }

  async markTransferred(
    target: { chainId: number; contract: string; tokenId: string; walletId: string },
    transferredTo: string,
  ): Promise<void> {
    const row = this.rows.find(
      (r) =>
        r.chainId === target.chainId &&
        r.contract.toLowerCase() === target.contract.toLowerCase() &&
        r.tokenId === target.tokenId &&
        r.walletId === target.walletId &&
        r.transferredAt === null,
    );
    if (row) {
      row.transferredAt = new Date();
      row.transferredTo = transferredTo;
    }
  }

  async recordDrainFailure(target: { chainId: number; contract: string; tokenId: string; walletId: string }, error: string): Promise<void> {
    const row = this.rows.find(
      (r) =>
        r.chainId === target.chainId &&
        r.contract.toLowerCase() === target.contract.toLowerCase() &&
        r.tokenId === target.tokenId &&
        r.walletId === target.walletId &&
        r.transferredAt === null,
    );
    if (row) {
      row.drainError = error;
      row.drainFailedAt = new Date();
    }
  }

  async findLatestDrainFailure(ownerId: string, chainId: number): Promise<MintedNftRecord | null> {
    const matches = this.rows.filter(
      (r) => r.ownerId === ownerId && r.chainId === chainId && r.drainFailedAt !== null && r.transferredAt === null,
    );
    if (matches.length === 0) return null;
    return matches.reduce((latest, row) => (row.drainFailedAt! > latest.drainFailedAt! ? row : latest));
  }
}
