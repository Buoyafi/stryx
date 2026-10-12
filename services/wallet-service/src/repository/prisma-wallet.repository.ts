import type { EncryptedPrivateKeyRecord } from '@stryx/key-management';
import type { WalletRepository, WalletListFilter } from './wallet.repository.js';
import type { KeyMaterialUpdate, NewWalletData, WalletRecord, WalletStatus } from '../types/wallet.types.js';
import type { UserId } from '../types/user-id.js';
import { WalletRecordSchema } from '../types/wallet.types.js';

/** The minimal subset of a generated Prisma `wallet` delegate this repository needs. */
export interface WalletPrismaDelegate {
  delete(args: { where: { id: string; userId: string } }): Promise<unknown>;
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  findUnique(
    args: { where: { id: string; userId: string } | { address: string } | { id: string } },
  ): Promise<Record<string, unknown> | null>;
  update(args: { where: { id: string; userId: string }; data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  findMany(args?: { where?: Record<string, unknown> }): Promise<Record<string, unknown>[]>;
}

export class PrismaWalletRepository implements WalletRepository {
  constructor(private readonly wallet: WalletPrismaDelegate) {}

  async create(data: NewWalletData): Promise<WalletRecord> {
    const row = await this.wallet.create({ data: { ...data, address: data.address.toLowerCase() } });
    return WalletRecordSchema.parse(row);
  }

  async findById(ownerId: UserId, id: string): Promise<WalletRecord | null> {
    const row = await this.wallet.findUnique({ where: { id, userId: ownerId } });
    return row ? WalletRecordSchema.parse(row) : null;
  }

  /** Global by design (ADR-002 §3.3), used only to check address collisions on import. */
  async existsByAddress(address: string): Promise<boolean> {
    const row = await this.wallet.findUnique({ where: { address: address.toLowerCase() } });
    return row !== null;
  }

  /** Global by design (ADR-002 §3.3), used only by the signing adapter. Key material only. */
  async getKeyMaterialForSigning(id: string): Promise<EncryptedPrivateKeyRecord | null> {
    const row = await this.wallet.findUnique({ where: { id } });
    if (!row) return null;
    const record = WalletRecordSchema.parse(row);
    return {
      encryptedPrivateKey: record.encryptedPrivateKey,
      wrappedDek: record.wrappedDek,
      iv: record.iv,
      authTag: record.authTag,
      keyVersion: record.keyVersion,
    };
  }

  async updateKeyMaterial(ownerId: UserId, id: string, update: KeyMaterialUpdate): Promise<WalletRecord> {
    const row = await this.wallet.update({ where: { id, userId: ownerId }, data: { ...update } });
    return WalletRecordSchema.parse(row);
  }

  async updateStatus(ownerId: UserId, id: string, status: WalletStatus): Promise<WalletRecord> {
    const row = await this.wallet.update({ where: { id, userId: ownerId }, data: { status } });
    return WalletRecordSchema.parse(row);
  }

  async updateLabel(ownerId: UserId, id: string, label: string | null): Promise<WalletRecord> {
    const row = await this.wallet.update({ where: { id, userId: ownerId }, data: { label } });
    return WalletRecordSchema.parse(row);
  }

  async delete(ownerId: UserId, id: string): Promise<void> {
    await this.wallet.delete({ where: { id, userId: ownerId } });
  }

  async list(ownerId: UserId, filter?: WalletListFilter): Promise<WalletRecord[]> {
    const rows = await this.wallet.findMany({ where: { userId: ownerId, ...filter } });
    return rows.map((row) => WalletRecordSchema.parse(row));
  }
}
