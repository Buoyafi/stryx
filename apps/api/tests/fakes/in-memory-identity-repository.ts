import { randomUUID } from 'node:crypto';
import {
  codeUsable,
  type AccessCodeListItem,
  type AccessCodeRecord,
  type IdentityRepository,
  type RedeemResult,
  type RevokeResult,
  type SignInWalletRecord,
} from '../../src/identity-repository.js';
import type { InMemoryUserRepository } from './in-memory-user.repository.js';

/** In-memory IdentityRepository. Creates accounts in the given user repository, as the real one does in `users`. */
export class InMemoryIdentityRepository implements IdentityRepository {
  readonly codes = new Map<string, AccessCodeRecord & { codeHash: string }>();
  readonly wallets = new Map<string, SignInWalletRecord & { lastUsedAt: Date | null }>();

  constructor(private readonly users: InMemoryUserRepository) {}

  async createAccessCode(data: { codeHash: string; label: string | null; createdById: string; boundAddressLower: string | null; expiresAt: Date | null }): Promise<AccessCodeRecord> {
    const record = { id: randomUUID(), ...data, revokedAt: null, redeemedAt: null, redeemedById: null, createdAt: new Date() };
    this.codes.set(record.id, record);
    return strip(record);
  }

  async findAccessCodeByHash(codeHash: string): Promise<AccessCodeRecord | null> {
    for (const c of this.codes.values()) if (c.codeHash === codeHash) return strip(c);
    return null;
  }

  async findAccessCodeById(id: string): Promise<AccessCodeRecord | null> {
    const c = this.codes.get(id);
    return c ? strip(c) : null;
  }

  async listAccessCodes(limit: number): Promise<AccessCodeListItem[]> {
    return [...this.codes.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((c) => ({ ...strip(c), redeemedByAddress: c.redeemedById ? ([...this.wallets.values()].find((w) => w.userId === c.redeemedById)?.address ?? null) : null }));
  }

  async revokeAccessCode(id: string, at: Date): Promise<RevokeResult> {
    const c = this.codes.get(id);
    if (!c) return 'not_found';
    if (c.redeemedAt) return 'already_used';
    if (c.revokedAt) return 'already_revoked';
    c.revokedAt = at;
    return 'revoked';
  }

  async findSignInWallet(addressLower: string): Promise<SignInWalletRecord | null> {
    const w = this.wallets.get(addressLower);
    return w ? { id: w.id, userId: w.userId, address: w.address } : null;
  }

  async listSignInWallets(userId: string): Promise<SignInWalletRecord[]> {
    return [...this.wallets.values()].filter((w) => w.userId === userId).map((w) => ({ id: w.id, userId: w.userId, address: w.address }));
  }

  async touchSignInWallet(id: string, at: Date): Promise<void> {
    for (const w of this.wallets.values()) if (w.id === id) w.lastUsedAt = at;
  }

  async redeemAndCreateAccount(input: { codeId: string; address: string; chainId: number; now: Date }): Promise<RedeemResult> {
    const c = this.codes.get(input.codeId);
    if (!c || !codeUsable(c, input.now)) return 'code_unusable';
    if (this.wallets.has(input.address.toLowerCase())) return 'wallet_taken';
    const userId = randomUUID();
    this.users.seed({ id: userId, email: null, passwordHash: null, role: 'USER', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: true, createdAt: input.now, updatedAt: input.now });
    const wallet = { id: randomUUID(), userId, address: input.address, lastUsedAt: input.now };
    this.wallets.set(input.address.toLowerCase(), wallet);
    c.redeemedAt = input.now;
    c.redeemedById = userId;
    return { userId, signInWalletId: wallet.id };
  }
}

function strip(c: AccessCodeRecord & { codeHash: string }): AccessCodeRecord {
  const { codeHash: _codeHash, ...rest } = c;
  return { ...rest };
}
