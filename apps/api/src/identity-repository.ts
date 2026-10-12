/** Persistence for wallet sign-in (ADR-003 §4.4) and invite codes. */

export interface AccessCodeRecord {
  id: string;
  label: string | null;
  createdById: string;
  boundAddressLower: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  redeemedAt: Date | null;
  redeemedById: string | null;
  createdAt: Date;
}

export interface AccessCodeListItem extends AccessCodeRecord {
  /** The wallet that used it, when it has been used. */
  redeemedByAddress: string | null;
}

export interface SignInWalletRecord {
  id: string;
  userId: string;
  address: string;
}

export type RevokeResult = 'revoked' | 'not_found' | 'already_used' | 'already_revoked';
export type RedeemResult = { userId: string; signInWalletId: string } | 'code_unusable' | 'wallet_taken';

export interface IdentityRepository {
  createAccessCode(data: { codeHash: string; label: string | null; createdById: string; boundAddressLower: string | null; expiresAt: Date | null }): Promise<AccessCodeRecord>;
  findAccessCodeByHash(codeHash: string): Promise<AccessCodeRecord | null>;
  findAccessCodeById(id: string): Promise<AccessCodeRecord | null>;
  listAccessCodes(limit: number): Promise<AccessCodeListItem[]>;
  revokeAccessCode(id: string, at: Date): Promise<RevokeResult>;
  findSignInWallet(addressLower: string): Promise<SignInWalletRecord | null>;
  listSignInWallets(userId: string): Promise<SignInWalletRecord[]>;
  touchSignInWallet(id: string, at: Date): Promise<void>;
  redeemAndCreateAccount(input: { codeId: string; address: string; chainId: number; now: Date }): Promise<RedeemResult>;
}

/** An access code is usable when nothing has used, revoked or expired it. */
export function codeUsable(code: Pick<AccessCodeRecord, 'redeemedAt' | 'revokedAt' | 'expiresAt'>, now: Date): boolean {
  return !code.redeemedAt && !code.revokedAt && (!code.expiresAt || code.expiresAt.getTime() > now.getTime());
}

type Row = Record<string, unknown>;
interface Delegate {
  create(args: { data: Row }): Promise<Row>;
  findUnique(args: { where: Row }): Promise<Row | null>;
  findMany(args: Row): Promise<Row[]>;
  updateMany(args: { where: Row; data: Row }): Promise<{ count: number }>;
  update(args: { where: Row; data: Row }): Promise<Row>;
}
export interface IdentityPrismaClient {
  accessCode: Delegate;
  signInWallet: Delegate;
  user: Delegate;
  $transaction<T>(fn: (tx: Omit<IdentityPrismaClient, '$transaction'>) => Promise<T>): Promise<T>;
}

const toCode = (row: Row): AccessCodeRecord => ({
  id: row.id as string,
  label: (row.label as string | null) ?? null,
  createdById: row.createdById as string,
  boundAddressLower: (row.boundAddressLower as string | null) ?? null,
  expiresAt: (row.expiresAt as Date | null) ?? null,
  revokedAt: (row.revokedAt as Date | null) ?? null,
  redeemedAt: (row.redeemedAt as Date | null) ?? null,
  redeemedById: (row.redeemedById as string | null) ?? null,
  createdAt: row.createdAt as Date,
});
const toWallet = (row: Row): SignInWalletRecord => ({ id: row.id as string, userId: row.userId as string, address: row.address as string });

/** Prisma's unique-constraint error, without importing Prisma's runtime error classes. */
const isUniqueViolation = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

class CodeUnusable extends Error {}

export class PrismaIdentityRepository implements IdentityRepository {
  constructor(private readonly prisma: IdentityPrismaClient) {}

  async createAccessCode(data: { codeHash: string; label: string | null; createdById: string; boundAddressLower: string | null; expiresAt: Date | null }): Promise<AccessCodeRecord> {
    return toCode(await this.prisma.accessCode.create({ data }));
  }

  async findAccessCodeByHash(codeHash: string): Promise<AccessCodeRecord | null> {
    const row = await this.prisma.accessCode.findUnique({ where: { codeHash } });
    return row ? toCode(row) : null;
  }

  async findAccessCodeById(id: string): Promise<AccessCodeRecord | null> {
    const row = await this.prisma.accessCode.findUnique({ where: { id } });
    return row ? toCode(row) : null;
  }

  async listAccessCodes(limit: number): Promise<AccessCodeListItem[]> {
    const rows = await this.prisma.accessCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { redeemedBy: { select: { signInWallets: { select: { address: true }, orderBy: { addedAt: 'asc' }, take: 1 } } } },
    });
    return rows.map((row) => {
      const by = row.redeemedBy as { signInWallets?: { address: string }[] } | null | undefined;
      return { ...toCode(row), redeemedByAddress: by?.signInWallets?.[0]?.address ?? null };
    });
  }

  async revokeAccessCode(id: string, at: Date): Promise<RevokeResult> {
    const { count } = await this.prisma.accessCode.updateMany({ where: { id, redeemedAt: null, revokedAt: null }, data: { revokedAt: at } });
    if (count === 1) return 'revoked';
    const row = await this.prisma.accessCode.findUnique({ where: { id } });
    if (!row) return 'not_found';
    return row.redeemedAt ? 'already_used' : 'already_revoked';
  }

  async findSignInWallet(addressLower: string): Promise<SignInWalletRecord | null> {
    const row = await this.prisma.signInWallet.findUnique({ where: { addressLower } });
    return row ? toWallet(row) : null;
  }

  async listSignInWallets(userId: string): Promise<SignInWalletRecord[]> {
    return (await this.prisma.signInWallet.findMany({ where: { userId }, orderBy: { addedAt: 'asc' } })).map(toWallet);
  }

  async touchSignInWallet(id: string, at: Date): Promise<void> {
    await this.prisma.signInWallet.updateMany({ where: { id }, data: { lastUsedAt: at } });
  }

  async redeemAndCreateAccount(input: { codeId: string; address: string; chainId: number; now: Date }): Promise<RedeemResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.accessCode.updateMany({
          where: { id: input.codeId, redeemedAt: null, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: input.now } }] },
          data: { redeemedAt: input.now },
        });
        if (claimed.count !== 1) throw new CodeUnusable();
        const user = await tx.user.create({
          data: { email: null, passwordHash: null, role: 'USER', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: true },
        });
        const wallet = await tx.signInWallet.create({
          data: { userId: user.id, address: input.address, addressLower: input.address.toLowerCase(), kind: 'EOA', chainId: null, lastUsedAt: input.now },
        });
        await tx.accessCode.update({ where: { id: input.codeId }, data: { redeemedById: user.id } });
        return { userId: user.id as string, signInWalletId: wallet.id as string };
      });
    } catch (err) {
      // Rolled back either way: the code is untouched unless the whole account was created.
      if (err instanceof CodeUnusable) return 'code_unusable';
      if (isUniqueViolation(err)) return 'wallet_taken';
      throw err;
    }
  }
}
