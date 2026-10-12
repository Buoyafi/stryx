export type NftStandard = 'erc721' | 'erc1155';

export interface MintedNftEntry {
  walletId: string;
  ownerId: string;
  chainId: number;
  contract: string;
  /** Decimal string: a tokenId routinely exceeds JS's safe-integer range. */
  tokenId: string;
  standard: NftStandard;
  /** "1" for a 721; a 1155's real minted quantity for this tokenId otherwise. */
  amount: string;
}

export interface MintedNftRecord extends MintedNftEntry {
  id: string;
  mintedAt: Date;
  transferredAt: Date | null;
  transferredTo: string | null;
  drainError: string | null;
  drainFailedAt: Date | null;
}

/** Persistence for MintedNft: the ledger of which tokenId each mint produced. */
export interface NftLedgerPrismaDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown>; take?: number }): Promise<unknown[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
}

export interface NftLedgerRepository {
  create(entry: MintedNftEntry): Promise<void>;
  /** Everything a wallet still holds on one chain: rows with no transferredAt yet. */
  listHeld(walletId: string, chainId: number): Promise<MintedNftRecord[]>;
  /** Tokens Stryx moved TO this address on one chain (it may have moved them on since). */
  listReceived(address: string, chainId: number): Promise<MintedNftRecord[]>;
  /** Marks one specific token as moved out of custody. */
  markTransferred(target: { chainId: number; contract: string; tokenId: string; walletId: string }, transferredTo: string): Promise<void>;
  /** Records a failed vault auto-drain attempt for one token. A no-op if no matching row exists. */
  recordDrainFailure(target: { chainId: number; contract: string; tokenId: string; walletId: string }, error: string): Promise<void>;
  /** The most recent still-unresolved drain failure for this owner on this chain, if any. */
  findLatestDrainFailure(ownerId: string, chainId: number): Promise<MintedNftRecord | null>;
}

/** An address is one contract however it is capitalised. */
const heldRow = (target: { chainId: number; contract: string; tokenId: string; walletId: string }) => ({
  chainId: target.chainId,
  walletId: target.walletId,
  tokenId: target.tokenId,
  contract: { equals: target.contract, mode: 'insensitive' },
});

export class PrismaNftLedgerRepository implements NftLedgerRepository {
  constructor(private readonly mintedNft: NftLedgerPrismaDelegate) {}

  async create(entry: MintedNftEntry): Promise<void> {
    await this.mintedNft.create({
      data: {
        walletId: entry.walletId,
        ownerId: entry.ownerId,
        chainId: entry.chainId,
        contract: entry.contract,
        tokenId: entry.tokenId,
        standard: entry.standard,
        amount: entry.amount,
      },
    });
  }

  async listHeld(walletId: string, chainId: number): Promise<MintedNftRecord[]> {
    const rows = await this.mintedNft.findMany({ where: { walletId, chainId, transferredAt: null } });
    return rows as MintedNftRecord[];
  }

  async listReceived(address: string, chainId: number): Promise<MintedNftRecord[]> {
    const rows = await this.mintedNft.findMany({ where: { chainId, transferredTo: { equals: address, mode: 'insensitive' } } });
    return rows as MintedNftRecord[];
  }

  async markTransferred(
    target: { chainId: number; contract: string; tokenId: string; walletId: string },
    transferredTo: string,
  ): Promise<void> {
    await this.mintedNft.updateMany({
      where: { ...heldRow(target), transferredAt: null },
      data: { transferredAt: new Date(), transferredTo },
    });
  }

  async recordDrainFailure(target: { chainId: number; contract: string; tokenId: string; walletId: string }, error: string): Promise<void> {
    await this.mintedNft.updateMany({
      where: { ...heldRow(target), transferredAt: null },
      data: { drainError: error, drainFailedAt: new Date() },
    });
  }

  async findLatestDrainFailure(ownerId: string, chainId: number): Promise<MintedNftRecord | null> {
    // transferredAt: null also excludes a token whose automatic transfer failed and was resolved
    // later.
    const rows = (await this.mintedNft.findMany({
      where: { ownerId, chainId, drainFailedAt: { not: null }, transferredAt: null },
      orderBy: { drainFailedAt: 'desc' },
      take: 1,
    })) as MintedNftRecord[];
    return rows[0] ?? null;
  }
}
