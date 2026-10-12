/** The landing page waitlist: people who left an email to hear when a place opens. */

export type WaitlistStatus = 'WAITING' | 'INVITED';

export interface WaitlistRow {
  id: string;
  email: string;
  status: WaitlistStatus;
  note: string | null;
  invitedAt: Date | null;
  createdAt: Date;
}

export interface WaitlistRepository {
  /** Adds the address unless it is already there. True when a new row was made. */
  addIfNew(email: string, emailLower: string): Promise<boolean>;
  /** Newest first. */
  list(filter: { status?: WaitlistStatus; limit: number }): Promise<WaitlistRow[]>;
  counts(): Promise<{ waiting: number; invited: number }>;
  setInvited(id: string, invited: boolean, at: Date): Promise<WaitlistRow | null>;
  /** Marks a WAITING person invited, in one conditional update, and returns them; null when they are not there or not waiting. */
  claimForInvite(id: string, at: Date): Promise<WaitlistRow | null>;
  remove(id: string): Promise<boolean>;
}

const LOCAL = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+$/u;
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

/** A plausible email, or null. */
export function normaliseEmail(input: unknown): { email: string; emailLower: string } | null {
  if (typeof input !== 'string') return null;
  const email = input.trim();
  if (email.length < 3 || email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => l.length >= 1 && l.length <= 63 && LABEL.test(l))) return null;
  if (labels[labels.length - 1]!.length < 2) return null;
  return { email, emailLower: email.toLowerCase() };
}

/** One CSV cell. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function waitlistCsv(rows: readonly WaitlistRow[]): string {
  const lines = ['email,status,joined,invited,note', ...rows.map((r) => [r.email, r.status.toLowerCase(), r.createdAt.toISOString(), r.invitedAt ? r.invitedAt.toISOString() : '', r.note ?? ''].map(csvCell).join(','))];
  return lines.join('\r\n') + '\r\n';
}

export class WaitlistService {
  constructor(
    private readonly repository: WaitlistRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Adds a visitor. 'invalid' for something that is not an email; 'added' and 'already' look the same to the visitor. */
  async join(raw: unknown): Promise<'added' | 'already' | 'invalid'> {
    const parsed = normaliseEmail(raw);
    if (!parsed) return 'invalid';
    return (await this.repository.addIfNew(parsed.email, parsed.emailLower)) ? 'added' : 'already';
  }

  list(filter: { status?: WaitlistStatus; limit?: number } = {}): Promise<WaitlistRow[]> {
    return this.repository.list({ ...(filter.status ? { status: filter.status } : {}), limit: filter.limit ?? 1000 });
  }

  counts(): Promise<{ waiting: number; invited: number }> {
    return this.repository.counts();
  }

  setInvited(id: string, invited: boolean): Promise<WaitlistRow | null> {
    return this.repository.setInvited(id, invited, this.now());
  }

  claimForInvite(id: string): Promise<WaitlistRow | null> {
    return this.repository.claimForInvite(id, this.now());
  }

  remove(id: string): Promise<boolean> {
    return this.repository.remove(id);
  }
}

// ---- Prisma ----

type Row = Record<string, unknown>;
interface WaitlistDelegate {
  createMany(args: { data: Row[]; skipDuplicates: boolean }): Promise<{ count: number }>;
  findMany(args: Row): Promise<Row[]>;
  count(args?: Row): Promise<number>;
  update(args: { where: Row; data: Row }): Promise<Row>;
  updateMany(args: { where: Row; data: Row }): Promise<{ count: number }>;
  findUnique(args: { where: Row }): Promise<Row | null>;
  deleteMany(args: { where: Row }): Promise<{ count: number }>;
}
export interface WaitlistPrismaClient {
  waitlistEntry: WaitlistDelegate;
}

const toRow = (r: Row): WaitlistRow => ({
  id: r['id'] as string,
  email: r['email'] as string,
  status: r['status'] as WaitlistStatus,
  note: (r['note'] as string | null) ?? null,
  invitedAt: (r['invitedAt'] as Date | null) ?? null,
  createdAt: r['createdAt'] as Date,
});

export class PrismaWaitlistRepository implements WaitlistRepository {
  constructor(private readonly prisma: WaitlistPrismaClient) {}

  async addIfNew(email: string, emailLower: string): Promise<boolean> {
    const { count } = await this.prisma.waitlistEntry.createMany({ data: [{ email, emailLower }], skipDuplicates: true });
    return count === 1;
  }

  async list(filter: { status?: WaitlistStatus; limit: number }): Promise<WaitlistRow[]> {
    const rows = await this.prisma.waitlistEntry.findMany({
      ...(filter.status ? { where: { status: filter.status } } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
    });
    return rows.map(toRow);
  }

  async counts(): Promise<{ waiting: number; invited: number }> {
    const [waiting, invited] = await Promise.all([this.prisma.waitlistEntry.count({ where: { status: 'WAITING' } }), this.prisma.waitlistEntry.count({ where: { status: 'INVITED' } })]);
    return { waiting, invited };
  }

  async setInvited(id: string, invited: boolean, at: Date): Promise<WaitlistRow | null> {
    try {
      const row = await this.prisma.waitlistEntry.update({ where: { id }, data: invited ? { status: 'INVITED', invitedAt: at } : { status: 'WAITING', invitedAt: null } });
      return toRow(row);
    } catch (err) {
      // Prisma's "record to update not found": the person was removed in the meantime.
      if ((err as { code?: string }).code === 'P2025') return null;
      throw err;
    }
  }

  async claimForInvite(id: string, at: Date): Promise<WaitlistRow | null> {
    const { count } = await this.prisma.waitlistEntry.updateMany({ where: { id, status: 'WAITING' }, data: { status: 'INVITED', invitedAt: at } });
    if (count !== 1) return null;
    const row = await this.prisma.waitlistEntry.findUnique({ where: { id } });
    return row ? toRow(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const { count } = await this.prisma.waitlistEntry.deleteMany({ where: { id } });
    return count === 1;
  }
}
