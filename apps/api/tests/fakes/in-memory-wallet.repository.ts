import { randomUUID } from 'node:crypto';
import type { WalletRepository, WalletListFilter, KeyMaterialUpdate, NewWalletData, WalletRecord, WalletStatus, UserId } from '@stryx/wallet-service';

/**
 * Mirrors PrismaWalletRepository's ownership scoping (ADR-002 §3.3): a row owned by someone else
 * behaves like a row that does not exist.
 */
export class InMemoryWalletRepository implements WalletRepository {
  private readonly byId = new Map<string, WalletRecord>();

  async create(data: NewWalletData): Promise<WalletRecord> {
    const now = new Date();
    const record: WalletRecord = { ...data, address: data.address.toLowerCase(), id: randomUUID(), createdAt: now, updatedAt: now };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(ownerId: UserId, id: string): Promise<WalletRecord | null> {
    const record = this.byId.get(id);
    return record && record.userId === ownerId ? record : null;
  }

  async existsByAddress(address: string): Promise<boolean> {
    const target = address.toLowerCase();
    for (const record of this.byId.values()) {
      if (record.address === target) return true;
    }
    return false;
  }

  async getKeyMaterialForSigning(id: string) {
    const record = this.byId.get(id);
    if (!record) return null;
    return {
      encryptedPrivateKey: record.encryptedPrivateKey,
      wrappedDek: record.wrappedDek,
      iv: record.iv,
      authTag: record.authTag,
      keyVersion: record.keyVersion,
    };
  }

  async updateKeyMaterial(ownerId: UserId, id: string, update: KeyMaterialUpdate): Promise<WalletRecord> {
    const existing = await this.findById(ownerId, id);
    if (!existing) throw new Error(`wallet ${id} not found`);
    const updated: WalletRecord = { ...existing, ...update, updatedAt: new Date() };
    this.byId.set(id, updated);
    return updated;
  }

  async updateStatus(ownerId: UserId, id: string, status: WalletStatus): Promise<WalletRecord> {
    const existing = await this.findById(ownerId, id);
    if (!existing) throw new Error(`wallet ${id} not found`);
    const updated: WalletRecord = { ...existing, status, updatedAt: new Date() };
    this.byId.set(id, updated);
    return updated;
  }

  async updateLabel(ownerId: UserId, id: string, label: string | null): Promise<WalletRecord> {
    const existing = await this.findById(ownerId, id);
    if (!existing) throw new Error(`wallet ${id} not found`);
    const updated: WalletRecord = { ...existing, label, updatedAt: new Date() };
    this.byId.set(id, updated);
    return updated;
  }

  async delete(ownerId: UserId, id: string): Promise<void> {
    const existing = await this.findById(ownerId, id);
    if (!existing) return;
    this.byId.delete(id);
  }

  async list(ownerId: UserId, filter?: WalletListFilter): Promise<WalletRecord[]> {
    let records = [...this.byId.values()].filter((r) => r.userId === ownerId);
    if (filter?.tier) records = records.filter((r) => r.tier === filter.tier);
    if (filter?.status) records = records.filter((r) => r.status === filter.status);
    return records;
  }
}
