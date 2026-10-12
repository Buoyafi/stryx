import { getAddress, isAddress } from 'viem';
import { RESERVED_OPERATOR_USER_ID } from './reserved-users.js';

/** What the operator scripts do, kept apart from the command line so it is tested (ADR-003 §4.10). */

export interface AdminAccount {
  id: string;
  displayName: string | null;
  addresses: string[];
  spendCapEnabled: boolean;
}

type AccountRow = { id: string; role: string; status: string; spendCapEnabled: boolean };

export interface OperatorAdminStore {
  findSignInWallet(addressLower: string): Promise<{ userId: string } | null>;
  addSignInWallet(userId: string, address: string): Promise<void>;
  listSignInAddresses(userId: string): Promise<string[]>;
  getUser(id: string): Promise<AccountRow | null>;
  setRole(userId: string, role: 'ADMIN' | 'USER'): Promise<void>;
  setSpendCapEnabled(userId: string, enabled: boolean): Promise<void>;
  listAdmins(): Promise<AdminAccount[]>;
  audit(entry: { action: string; targetUserId: string; detail: string }): Promise<void>;
}

export type OperatorResult = { ok: boolean; message: string };

function parseAddress(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  return isAddress(value, { strict: false }) ? getAddress(value) : null;
}

const NOT_AN_ADDRESS: OperatorResult = { ok: false, message: 'Give a wallet address, 0x followed by 40 hex characters.' };

export async function adoptWallet(store: OperatorAdminStore, raw: string | undefined): Promise<OperatorResult> {
  const address = parseAddress(raw);
  if (!address) return NOT_AN_ADDRESS;
  const operator = await store.getUser(RESERVED_OPERATOR_USER_ID);
  if (!operator) return { ok: false, message: 'The operator account is missing from this database. Run the migrations first.' };
  const existing = await store.findSignInWallet(address.toLowerCase());
  if (existing?.userId === RESERVED_OPERATOR_USER_ID) return { ok: true, message: `${address} already signs in to the operator account. Nothing changed.` };
  if (existing) {
    return {
      ok: false,
      message: `${address} already signs in to another account (${existing.userId}). Use a wallet that has never signed in to Stryx, so the operator account and that account stay separate.`,
    };
  }
  await store.addSignInWallet(RESERVED_OPERATOR_USER_ID, address);
  await store.audit({ action: 'operator.adopt_wallet', targetUserId: RESERVED_OPERATOR_USER_ID, detail: address });
  const count = (await store.listSignInAddresses(RESERVED_OPERATOR_USER_ID)).length;
  const advice = count < 2 ? ' Add a second wallet the same way, so losing one never locks you out.' : '';
  return { ok: true, message: `${address} now signs in to the operator account (${count} wallet${count === 1 ? '' : 's'}).${advice}` };
}

async function accountFor(store: OperatorAdminStore, raw: string | undefined): Promise<{ address: string; user: AccountRow } | OperatorResult> {
  const address = parseAddress(raw);
  if (!address) return NOT_AN_ADDRESS;
  const wallet = await store.findSignInWallet(address.toLowerCase());
  const user = wallet ? await store.getUser(wallet.userId) : null;
  if (!user) return { ok: false, message: `No account signs in with ${address}. They need to sign in to Stryx once first.` };
  return { address, user };
}

export async function grantAdmin(store: OperatorAdminStore, raw: string | undefined): Promise<OperatorResult> {
  const found = await accountFor(store, raw);
  if ('ok' in found) return found;
  if (found.user.role === 'ADMIN') return { ok: true, message: `The account for ${found.address} is already an admin. Nothing changed.` };
  if (found.user.status !== 'ACTIVE') return { ok: false, message: `The account for ${found.address} is suspended. Unsuspend it before making it an admin.` };
  await store.setRole(found.user.id, 'ADMIN');
  await store.audit({ action: 'role.grant', targetUserId: found.user.id, detail: `ADMIN via ${found.address}` });
  return { ok: true, message: `The account for ${found.address} is now an admin. Its next sign-in gets a short admin session (1 hour idle, 12 hours at most).` };
}

/** `tokenIsAdmin`: the operator API token opens the admin pages (OPERATOR_TOKEN_MODE=admin). */
export async function revokeAdmin(store: OperatorAdminStore, raw: string | undefined, opts: { tokenIsAdmin?: boolean } = {}): Promise<OperatorResult> {
  const found = await accountFor(store, raw);
  if ('ok' in found) return found;
  if (found.user.role !== 'ADMIN') return { ok: true, message: `The account for ${found.address} is not an admin. Nothing changed.` };
  // Another admin only counts if it can reach the admin pages.
  const others = (await store.listAdmins()).filter(
    (a) => a.id !== found.user.id && (a.addresses.length > 0 || (a.id === RESERVED_OPERATOR_USER_ID && opts.tokenIsAdmin === true)),
  );
  if (others.length === 0) {
    return { ok: false, message: 'That is the last admin account that can reach the admin pages. Make another account an admin first (operator:grant), or give the operator account a sign-in wallet (operator:adopt).' };
  }
  const wasUncapped = !found.user.spendCapEnabled;
  await store.setRole(found.user.id, 'USER');
  await store.audit({ action: 'role.revoke', targetUserId: found.user.id, detail: `USER via ${found.address}` });
  // Running without spend caps is for admins only: a member goes back under them.
  if (wasUncapped) {
    await store.setSpendCapEnabled(found.user.id, true);
    await store.audit({ action: 'spend_cap.enable', targetUserId: found.user.id, detail: `with the admin role revoked, via ${found.address}` });
  }
  return { ok: true, message: `The account for ${found.address} is a member again. Its admin pages close on its next request${wasUncapped ? ', and its daily spend caps are back on' : ''}.` };
}

/** uncap: an admin account sends without daily spend caps, on every chain, for it and all its wallets. */
export async function uncapAccount(store: OperatorAdminStore, raw: string | undefined): Promise<OperatorResult> {
  const found = await accountFor(store, raw);
  if ('ok' in found) return found;
  if (found.user.role !== 'ADMIN') {
    return { ok: false, message: `The account for ${found.address} is a member. Only admin accounts can run without spend caps; make it an admin first (operator:grant) if that is what you mean.` };
  }
  if (!found.user.spendCapEnabled) return { ok: true, message: `The account for ${found.address} already has no spend caps. Nothing changed.` };
  await store.setSpendCapEnabled(found.user.id, false);
  await store.audit({ action: 'spend_cap.disable', targetUserId: found.user.id, detail: `via ${found.address}` });
  return {
    ok: true,
    message: `The account for ${found.address} now has no daily spend caps, on any chain, for the account or its wallets. It applies to its next transaction. Turn them back on with operator:cap.`,
  };
}

/** cap: the account's daily spend caps apply again (the account's and each wallet's share). */
export async function capAccount(store: OperatorAdminStore, raw: string | undefined): Promise<OperatorResult> {
  const found = await accountFor(store, raw);
  if ('ok' in found) return found;
  if (found.user.spendCapEnabled) return { ok: true, message: `The account for ${found.address} already has its spend caps on. Nothing changed.` };
  await store.setSpendCapEnabled(found.user.id, true);
  await store.audit({ action: 'spend_cap.enable', targetUserId: found.user.id, detail: `via ${found.address}` });
  return { ok: true, message: `The account for ${found.address} has its daily spend caps back on, from its next transaction.` };
}

export async function describeAdmins(store: OperatorAdminStore): Promise<OperatorResult> {
  const admins = await store.listAdmins();
  if (admins.length === 0) return { ok: true, message: 'No admin accounts.' };
  const lines = admins.map((a) => {
    const who = a.id === RESERVED_OPERATOR_USER_ID ? 'operator account' : a.id;
    const name = a.displayName ? ` "${a.displayName}"` : '';
    const wallets = a.addresses.length ? a.addresses.join(', ') : 'no sign-in wallet yet (API token only)';
    return `- ${who}${name}: ${wallets}${a.spendCapEnabled ? '' : ' (no spend caps)'}`;
  });
  return { ok: true, message: `${admins.length} admin account${admins.length === 1 ? '' : 's'}:\n${lines.join('\n')}` };
}

// ---------------------------------------------------------------- Postgres

type Row = Record<string, unknown>;
interface Delegate {
  findUnique(args: Row): Promise<Row | null>;
  findMany(args: Row): Promise<Row[]>;
  create(args: Row): Promise<Row>;
  update(args: Row): Promise<Row>;
}

/** The scripts' store, over a Prisma client connected with the migration role. */
export function prismaOperatorAdminStore(prisma: { user: unknown; signInWallet: unknown; auditLog: unknown }): OperatorAdminStore {
  const users = prisma.user as Delegate;
  const wallets = prisma.signInWallet as Delegate;
  const auditLog = prisma.auditLog as Delegate;
  return {
    async findSignInWallet(addressLower) {
      const row = await wallets.findUnique({ where: { addressLower } });
      return row ? { userId: row.userId as string } : null;
    },
    async addSignInWallet(userId, address) {
      await wallets.create({ data: { userId, address, addressLower: address.toLowerCase(), kind: 'EOA', chainId: null } });
    },
    async listSignInAddresses(userId) {
      return (await wallets.findMany({ where: { userId }, orderBy: { addedAt: 'asc' } })).map((r) => r.address as string);
    },
    async getUser(id) {
      const row = await users.findUnique({ where: { id } });
      return row ? { id: row.id as string, role: row.role as string, status: row.status as string, spendCapEnabled: row.spendCapEnabled !== false } : null;
    },
    async setRole(userId, role) {
      await users.update({ where: { id: userId }, data: { role } });
    },
    async setSpendCapEnabled(userId, enabled) {
      await users.update({ where: { id: userId }, data: { spendCapEnabled: enabled } });
    },
    async listAdmins() {
      const rows = await users.findMany({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' } });
      return Promise.all(
        rows.map(async (r) => ({
          id: r.id as string,
          displayName: (r.displayName as string | null) ?? null,
          spendCapEnabled: r.spendCapEnabled !== false,
          addresses: (await wallets.findMany({ where: { userId: r.id }, orderBy: { addedAt: 'asc' } })).map((w) => w.address as string),
        })),
      );
    },
    async audit(entry) {
      await auditLog.create({ data: { actorUserId: null, actorType: 'SYSTEM', action: entry.action, targetUserId: entry.targetUserId, outcome: 'SUCCESS', detail: entry.detail } });
    },
  };
}
