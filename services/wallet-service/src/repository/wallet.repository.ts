import type { EncryptedPrivateKeyRecord } from '@stryx/key-management';
import type { KeyMaterialUpdate, NewWalletData, WalletRecord, WalletStatus, WalletTier } from '../types/wallet.types.js';
import type { UserId } from '../types/user-id.js';

export interface WalletListFilter {
  tier?: WalletTier;
  status?: WalletStatus;
}

/**
 * Persistence contract for wallets. The service layer depends only on this interface. Every read and
 * write is scoped to an owner (ADR-002 §3.3), except the system-wide address check.
 */
export interface WalletRepository {
  create(data: NewWalletData): Promise<WalletRecord>;
  findById(ownerId: UserId, id: string): Promise<WalletRecord | null>;
  /** Global by design: see interface doc comment. Used only for import collision checks. */
  existsByAddress(address: string): Promise<boolean>;
  /** Global by design: see interface doc comment. Used only by the signing adapter. */
  getKeyMaterialForSigning(id: string): Promise<EncryptedPrivateKeyRecord | null>;
  updateKeyMaterial(ownerId: UserId, id: string, update: KeyMaterialUpdate): Promise<WalletRecord>;
  updateStatus(ownerId: UserId, id: string, status: WalletStatus): Promise<WalletRecord>;
  updateLabel(ownerId: UserId, id: string, label: string | null): Promise<WalletRecord>;
  /** Permanently removes the wallet row, destroying the only copy of its key material. Irreversible. */
  delete(ownerId: UserId, id: string): Promise<void>;
  list(ownerId: UserId, filter?: WalletListFilter): Promise<WalletRecord[]>;
}
