import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { WalletKeyService } from '@stryx/key-management';
import type { WalletRepository } from '../repository/wallet.repository.js';
import { toWalletSummary, type WalletOrigin, type WalletSummary } from '../types/wallet.types.js';
import type { UserId } from '../types/user-id.js';
import type { BulkCreateWalletInput, CreateWalletInput, ImportWalletInput } from '../dto/wallet.dto.js';
import { generateWalletName } from '../utils/name-generator.js';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Thrown when a wallet id does not exist and when it belongs to another owner (ADR-002 §3.3): the two
 * are indistinguishable to the caller.
 */
export class WalletNotFoundError extends Error {
  constructor(id: string) {
    super(`Wallet ${id} not found`);
    this.name = 'WalletNotFoundError';
  }
}

/** Whether a wallet may be deleted now, and why. */
export interface WalletDeletionCheck {
  canDelete: boolean;
  reason: 'empty' | 'key_elsewhere' | 'confirm_key' | 'has_funds' | 'balance_unreadable' | 'scheduled';
  message: string;
  funds: { chainName: string; amount: string }[];
  keyElsewhere: 'imported' | 'exported' | null;
  scheduled: number;
}

export type WalletDeletionChecker = (wallet: { id: string; address: string; origin: 'GENERATED' | 'IMPORTED'; ownerId: UserId }, opts: { keySaved: boolean }) => Promise<WalletDeletionCheck>;

/** A delete the check refused; carries the check so the caller can say why. */
export class WalletDeletionRefusedError extends Error {
  constructor(public readonly check: WalletDeletionCheck) {
    super(check.message);
    this.name = 'WalletDeletionRefusedError';
  }
}

/** A bulk generate that stopped part way: `created` wallets exist and are kept, the rest were never made. */
export class BulkCreateInterruptedError extends Error {
  constructor(
    public readonly created: WalletSummary[],
    public readonly requested: number,
    public override readonly cause: unknown,
  ) {
    super(`Created ${created.length} of ${requested} wallets, then stopped.`);
    this.name = 'BulkCreateInterruptedError';
  }
}

export class WalletAddressCollisionError extends Error {
  constructor(address: string) {
    super(`Wallet with address ${address} already exists`);
    this.name = 'WalletAddressCollisionError';
  }
}

/**
 * Thrown for a private key of the right shape that is not a valid secp256k1 scalar. Deliberately
 * carries no detail: viem's own error embeds the key.
 */
export class InvalidPrivateKeyError extends Error {
  constructor() {
    super('The provided value is not a valid private key.');
    this.name = 'InvalidPrivateKeyError';
  }
}

/** Wallet lifecycle: creation, import, rotation, lookup. Never touches raw private key material itself; WalletKeyService does. */
export class WalletService {
  constructor(
    private readonly repository: WalletRepository,
    private readonly walletKeyService: WalletKeyService,
    private readonly kmsKeyId: string,
    private readonly logger: Logger = noopLogger,
  ) {}

  /** Generates a brand new keypair, encrypts it, and persists it, owned by `ownerId`. */
  async createWallet(input: CreateWalletInput, ownerId: UserId): Promise<WalletSummary> {
    const privateKeyHex = generatePrivateKey();
    // Auto-name unnamed wallets so every row is distinguishable at a glance.
    return this.encryptAndStore(privateKeyHex, input.label ?? generateWalletName(), input.tier, ownerId, 'GENERATED');
  }

  /** Generates several wallets in one call. */
  async createWallets(input: BulkCreateWalletInput, ownerId: UserId): Promise<WalletSummary[]> {
    const pad = (n: number) => String(n).padStart(2, '0');
    const wallets: WalletSummary[] = [];
    for (let i = 1; i <= input.count; i++) {
      const label = input.labelPrefix ? `${input.labelPrefix}-${pad(i)}` : generateWalletName();
      try {
        wallets.push(await this.encryptAndStore(generatePrivateKey(), label, input.tier, ownerId, 'GENERATED'));
      } catch (err) {
        if (wallets.length === 0) throw err; // nothing was made: an ordinary failure
        throw new BulkCreateInterruptedError(wallets, input.count, err);
      }
    }
    return wallets;
  }

  /** Imports an existing private key (e.g. migrating a wallet in from elsewhere), owned by `ownerId`. */
  async importWallet(input: ImportWalletInput, ownerId: UserId): Promise<WalletSummary> {
    const privateKeyHex = input.privateKey as `0x${string}`;

    let address: `0x${string}`;
    try {
      address = privateKeyToAccount(privateKeyHex).address;
    } catch {
      // Not rethrowing viem's own error, which embeds the key's value.
      throw new InvalidPrivateKeyError();
    }

    // Address uniqueness is system-wide (ADR-002 §3.3), so this check is not scoped to the owner.
    if (await this.repository.existsByAddress(address)) {
      throw new WalletAddressCollisionError(address);
    }
    return this.encryptAndStore(privateKeyHex, input.label ?? generateWalletName(), input.tier, ownerId, 'IMPORTED');
  }

  async getWalletSummary(ownerId: UserId, id: string): Promise<WalletSummary> {
    const record = await this.repository.findById(ownerId, id);
    if (!record) throw new WalletNotFoundError(id);
    return toWalletSummary(record);
  }

  async listWallets(
    ownerId: UserId,
    filter?: { tier?: CreateWalletInput['tier']; status?: 'ACTIVE' | 'ARCHIVED' | 'COMPROMISED' },
  ): Promise<WalletSummary[]> {
    const records = await this.repository.list(ownerId, filter);
    return records.map(toWalletSummary);
  }

  /** Renames a wallet. Labels are cosmetic: the id and address remain the real identifiers. */
  async renameWallet(ownerId: UserId, id: string, label: string | null): Promise<WalletSummary> {
    const record = await this.repository.findById(ownerId, id);
    if (!record) throw new WalletNotFoundError(id);
    const updated = await this.repository.updateLabel(ownerId, id, label);
    return toWalletSummary(updated);
  }

  /** Soft delete: marks the wallet ARCHIVED so it drops out of normal views. */
  async archiveWallet(ownerId: UserId, id: string): Promise<WalletSummary> {
    const record = await this.repository.findById(ownerId, id);
    if (!record) throw new WalletNotFoundError(id);
    const updated = await this.repository.updateStatus(ownerId, id, 'ARCHIVED');
    this.logger.info('wallet archived', { walletId: id, address: record.address });
    return toWalletSummary(updated);
  }

  /** Restores an archived wallet to ACTIVE. */
  async unarchiveWallet(ownerId: UserId, id: string): Promise<WalletSummary> {
    const record = await this.repository.findById(ownerId, id);
    if (!record) throw new WalletNotFoundError(id);
    const updated = await this.repository.updateStatus(ownerId, id, 'ACTIVE');
    this.logger.info('wallet unarchived', { walletId: id, address: record.address });
    return toWalletSummary(updated);
  }

  /** What deleting this wallet would mean right now (the delete dialog shows it before asking). */
  async deletionCheck(ownerId: UserId, id: string, checker: WalletDeletionChecker, opts: { keySaved: boolean } = { keySaved: false }): Promise<WalletDeletionCheck> {
    const record = await this.repository.findById(ownerId, id);
    if (!record) throw new WalletNotFoundError(id);
    return checker({ id: record.id, address: record.address, origin: record.origin, ownerId }, opts);
  }

  /** Permanent delete: Stryx forgets the wallet and its key. */
  async deleteWalletPermanently(ownerId: UserId, id: string, checker: WalletDeletionChecker, opts: { keySaved: boolean } = { keySaved: false }): Promise<void> {
    const record = await this.repository.findById(ownerId, id);
    if (!record) throw new WalletNotFoundError(id);

    const check = await checker({ id: record.id, address: record.address, origin: record.origin, ownerId }, opts);
    if (!check.canDelete) throw new WalletDeletionRefusedError(check);

    await this.repository.delete(ownerId, id);
    this.logger.warn('wallet permanently deleted: key material destroyed', {
      walletId: id,
      address: record.address,
    });
  }

  /** Rotation per ADR-001 §3.4: new DEK, re-encrypted key, incremented keyVersion. */
  async rotateWalletKey(ownerId: UserId, id: string): Promise<WalletSummary> {
    const record = await this.repository.findById(ownerId, id);
    if (!record) throw new WalletNotFoundError(id);

    const rotated = await this.walletKeyService.rotateKey({ walletId: id }, record);
    const updated = await this.repository.updateKeyMaterial(ownerId, id, {
      encryptedPrivateKey: rotated.encryptedPrivateKey,
      wrappedDek: rotated.wrappedDek,
      iv: rotated.iv,
      authTag: rotated.authTag,
      keyVersion: rotated.keyVersion,
      kmsKeyId: this.kmsKeyId,
    });

    this.logger.info('wallet key rotated', { walletId: id, toVersion: rotated.keyVersion });
    return toWalletSummary(updated);
  }

  private async encryptAndStore(
    privateKeyHex: `0x${string}`,
    label: string | null,
    tier: CreateWalletInput['tier'],
    ownerId: UserId,
    // Required, no default: each caller must state which it is.
    origin: WalletOrigin,
  ): Promise<WalletSummary> {
    const address = privateKeyToAccount(privateKeyHex).address;
    const privateKeyBuffer = Buffer.from(privateKeyHex.slice(2), 'hex');

    // The wallet id is not known until after the insert; the address is a stable, non-secret scope for
    // the encryption log.
    const encrypted = await this.walletKeyService.encryptPrivateKeyForStorage(
      { walletId: address },
      privateKeyBuffer,
    );

    const record = await this.repository.create({
      address,
      userId: ownerId,
      label,
      tier: tier ?? 'HOT',
      status: 'ACTIVE',
      origin,
      encryptedPrivateKey: encrypted.encryptedPrivateKey,
      wrappedDek: encrypted.wrappedDek,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyVersion: encrypted.keyVersion,
      kmsKeyId: this.kmsKeyId,
    });

    this.logger.info('wallet created', { walletId: record.id, address: record.address, tier: record.tier });
    return toWalletSummary(record);
  }
}
