import { randomUUID } from 'node:crypto';
import { redactUrls } from '@stryx/utils';

/** The mint event log (ADR-003 §4.9): the server's own record of every mint attempt, one row per wallet. */

export type MintEventStatus = 'SENDING' | 'PENDING' | 'CONFIRMED' | 'REVERTED' | 'DROPPED' | 'BLOCKED';
export type MintEventSource = 'MANUAL' | 'SCHEDULED' | 'API';
export type MintEventKind = 'PUBLIC' | 'ALLOWLIST' | 'SIGNED';

export interface MintEventRow {
  id: string;
  ownerId: string;
  walletId: string;
  walletAddress: string;
  chainId: number;
  contractAddress: string;
  kind: MintEventKind;
  quantity: number;
  source: MintEventSource;
  jobId: string | null;
  status: MintEventStatus;
  failureReason: string | null;
  failureNote: string | null;
  txHash: string | null;
  nonce: number | null;
  blockNumber: string | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  feeWei: string | null;
  valueWei: string | null;
  createdAt: Date;
  broadcastAt: Date | null;
  settledAt: Date | null;
}

export type NewMintEvent = Pick<MintEventRow, 'ownerId' | 'walletId' | 'walletAddress' | 'chainId' | 'contractAddress' | 'kind' | 'quantity' | 'source' | 'jobId' | 'valueWei'>;

export interface Settlement {
  status: 'CONFIRMED' | 'REVERTED' | 'DROPPED';
  blockNumber?: string | null;
  gasUsed?: string | null;
  effectiveGasPriceWei?: string | null;
  feeWei?: string | null;
  settledAt: Date;
}

/** A position in an owner's newest-first list: the last row seen. The id breaks ties within one millisecond. */
export interface MintCursor {
  at: Date;
  id: string;
}

export interface MintEventRepository {
  insert(row: NewMintEvent & { status: 'SENDING' | 'PENDING' | 'BLOCKED'; txHash?: string | null; nonce?: number | null; broadcastAt?: Date | null; createdAt?: Date; failureReason?: string | null; failureNote?: string | null }): Promise<string>;
  update(id: string, patch: Partial<Pick<MintEventRow, 'status' | 'failureReason' | 'failureNote' | 'txHash' | 'nonce' | 'broadcastAt'>>): Promise<void>;
  settle(id: string, settlement: Settlement): Promise<void>;
  get(id: string): Promise<MintEventRow | null>;
  /** Newest first (createdAt, then id), strictly after the `before` cursor when given. */
  listForOwner(ownerId: string, opts: { before?: MintCursor; limit: number }): Promise<MintEventRow[]>;
  /** When the owner's oldest row was recorded, or null if they have none. */
  firstCreatedAt(ownerId: string): Promise<Date | null>;
  /** Oldest first: rows waiting on a receipt, after the `after` cursor when given. */
  listUnsettled(chainId: number, opts: { limit: number; droppedSince: Date; after?: MintCursor }): Promise<MintEventRow[]>;
  /** Whether anything is already on record for this job (makes copying a signed run safe to repeat). */
  hasJob(jobId: string): Promise<boolean>;
  /** Rows stuck in SENDING (no hash) since before `olderThan`: a crash between recording and signing. */
  listStuckSending(olderThan: Date, limit: number): Promise<MintEventRow[]>;
}

const NOTE_MAX = 200;

/** A short, safe note: no URL (RPC keys hide in them), no newlines, at most 200 characters. */
export function safeNote(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = redactUrls(text).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > NOTE_MAX ? `${clean.slice(0, NOTE_MAX - 1)}…` : clean;
}

// ---------------------------------------------------------------- Postgres

type Row = Record<string, unknown>;
export interface MintEventDelegate {
  create(args: { data: Row; select?: Row }): Promise<Row>;
  update(args: { where: Row; data: Row }): Promise<Row>;
  findUnique(args: { where: Row }): Promise<Row | null>;
  findMany(args: Row): Promise<Row[]>;
}

/** Whole-number text for a Decimal/BigInt column. Prisma's Decimal prints 1e+21 and up in exponent form, so use toFixed(). */
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && typeof (v as { toFixed?: unknown }).toFixed === 'function') return (v as { toFixed(): string }).toFixed();
  return String(v);
};

function toRow(r: Row): MintEventRow {
  return {
    id: r.id as string,
    ownerId: r.ownerId as string,
    walletId: r.walletId as string,
    walletAddress: r.walletAddress as string,
    chainId: r.chainId as number,
    contractAddress: r.contractAddress as string,
    kind: r.kind as MintEventKind,
    quantity: r.quantity as number,
    source: r.source as MintEventSource,
    jobId: (r.jobId as string | null) ?? null,
    status: r.status as MintEventStatus,
    failureReason: (r.failureReason as string | null) ?? null,
    failureNote: (r.failureNote as string | null) ?? null,
    txHash: (r.txHash as string | null) ?? null,
    nonce: (r.nonce as number | null) ?? null,
    blockNumber: str(r.blockNumber),
    gasUsed: str(r.gasUsed),
    effectiveGasPriceWei: str(r.effectiveGasPriceWei),
    feeWei: str(r.feeWei),
    valueWei: str(r.valueWei),
    createdAt: r.createdAt as Date,
    broadcastAt: (r.broadcastAt as Date | null) ?? null,
    settledAt: (r.settledAt as Date | null) ?? null,
  };
}

export class PrismaMintEventRepository implements MintEventRepository {
  constructor(private readonly mintEvent: MintEventDelegate) {}

  async insert(row: Parameters<MintEventRepository['insert']>[0]): Promise<string> {
    const created = await this.mintEvent.create({ data: row, select: { id: true } });
    return created.id as string;
  }

  async update(id: string, patch: Parameters<MintEventRepository['update']>[1]): Promise<void> {
    await this.mintEvent.update({ where: { id }, data: patch });
  }

  async settle(id: string, s: Settlement): Promise<void> {
    await this.mintEvent.update({
      where: { id },
      data: {
        status: s.status,
        settledAt: s.settledAt,
        ...(s.blockNumber != null ? { blockNumber: BigInt(s.blockNumber) } : {}),
        ...(s.gasUsed != null ? { gasUsed: s.gasUsed } : {}),
        ...(s.effectiveGasPriceWei != null ? { effectiveGasPriceWei: s.effectiveGasPriceWei } : {}),
        ...(s.feeWei != null ? { feeWei: s.feeWei } : {}),
      },
    });
  }

  async get(id: string): Promise<MintEventRow | null> {
    const r = await this.mintEvent.findUnique({ where: { id } });
    return r ? toRow(r) : null;
  }

  async listForOwner(ownerId: string, opts: { before?: MintCursor; limit: number }): Promise<MintEventRow[]> {
    const b = opts.before;
    const rows = await this.mintEvent.findMany({
      where: { ownerId, ...(b ? { OR: [{ createdAt: { lt: b.at } }, { createdAt: b.at, id: { lt: b.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit,
    });
    return rows.map(toRow);
  }

  async listUnsettled(chainId: number, opts: { limit: number; droppedSince: Date; after?: MintCursor }): Promise<MintEventRow[]> {
    const a = opts.after;
    const rows = await this.mintEvent.findMany({
      where: {
        chainId,
        txHash: { not: null },
        AND: [
          { OR: [{ status: 'PENDING' }, { status: 'DROPPED', createdAt: { gt: opts.droppedSince } }] },
          ...(a ? [{ OR: [{ createdAt: { gt: a.at } }, { createdAt: a.at, id: { gt: a.id } }] }] : []),
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: opts.limit,
    });
    return rows.map(toRow);
  }

  async firstCreatedAt(ownerId: string): Promise<Date | null> {
    const [first] = await this.mintEvent.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } });
    return (first?.createdAt as Date | undefined) ?? null;
  }

  async hasJob(jobId: string): Promise<boolean> {
    return (await this.mintEvent.findMany({ where: { jobId }, take: 1, select: { id: true } })).length > 0;
  }

  async listStuckSending(olderThan: Date, limit: number): Promise<MintEventRow[]> {
    const rows = await this.mintEvent.findMany({ where: { status: 'SENDING', txHash: null, createdAt: { lt: olderThan } }, orderBy: { createdAt: 'asc' }, take: limit });
    return rows.map(toRow);
  }
}

// ---------------------------------------------------------------- in memory (tests, and no-database runs)

const LEGAL: Record<MintEventStatus, readonly MintEventStatus[]> = {
  SENDING: ['PENDING', 'BLOCKED'],
  PENDING: ['CONFIRMED', 'REVERTED', 'DROPPED'],
  DROPPED: ['CONFIRMED', 'REVERTED'],
  CONFIRMED: [],
  REVERTED: [],
  BLOCKED: [],
};

/** Same rules as the Postgres trigger, so a test catches an illegal change the database would refuse. */
export class InMemoryMintEventRepository implements MintEventRepository {
  readonly rows = new Map<string, MintEventRow>();

  async insert(row: Parameters<MintEventRepository['insert']>[0]): Promise<string> {
    const id = randomUUID();
    this.rows.set(id, {
      id,
      failureReason: null,
      failureNote: null,
      txHash: null,
      nonce: null,
      blockNumber: null,
      gasUsed: null,
      effectiveGasPriceWei: null,
      feeWei: null,
      broadcastAt: null,
      settledAt: null,
      createdAt: new Date(),
      ...row,
    } as MintEventRow);
    return id;
  }

  private change(id: string, next: Partial<MintEventRow>) {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no mint event ${id}`);
    if (next.status && next.status !== row.status && !LEGAL[row.status].includes(next.status)) {
      throw new Error(`mint_events: illegal status change ${row.status} -> ${next.status} for ${id}`);
    }
    this.rows.set(id, { ...row, ...next });
  }

  async update(id: string, patch: Parameters<MintEventRepository['update']>[1]): Promise<void> {
    this.change(id, patch);
  }

  async settle(id: string, s: Settlement): Promise<void> {
    this.change(id, {
      status: s.status,
      settledAt: s.settledAt,
      ...(s.blockNumber != null ? { blockNumber: s.blockNumber } : {}),
      ...(s.gasUsed != null ? { gasUsed: s.gasUsed } : {}),
      ...(s.effectiveGasPriceWei != null ? { effectiveGasPriceWei: s.effectiveGasPriceWei } : {}),
      ...(s.feeWei != null ? { feeWei: s.feeWei } : {}),
    });
  }

  async get(id: string): Promise<MintEventRow | null> {
    return this.rows.get(id) ?? null;
  }

  async listForOwner(ownerId: string, opts: { before?: MintCursor; limit: number }): Promise<MintEventRow[]> {
    const b = opts.before;
    const after = (r: MintEventRow) => !b || r.createdAt < b.at || (r.createdAt.getTime() === b.at.getTime() && r.id < b.id);
    return [...this.rows.values()]
      .filter((r) => r.ownerId === ownerId && after(r))
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1))
      .slice(0, opts.limit);
  }

  async firstCreatedAt(ownerId: string): Promise<Date | null> {
    let first: Date | null = null;
    for (const r of this.rows.values()) if (r.ownerId === ownerId && (!first || r.createdAt < first)) first = r.createdAt;
    return first;
  }

  async listUnsettled(chainId: number, opts: { limit: number; droppedSince: Date; after?: MintCursor }): Promise<MintEventRow[]> {
    const a = opts.after;
    const past = (r: MintEventRow) => !a || r.createdAt > a.at || (r.createdAt.getTime() === a.at.getTime() && r.id > a.id);
    return [...this.rows.values()]
      .filter((r) => r.chainId === chainId && r.txHash && past(r) && (r.status === 'PENDING' || (r.status === 'DROPPED' && r.createdAt > opts.droppedSince)))
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : 1))
      .slice(0, opts.limit);
  }

  async hasJob(jobId: string): Promise<boolean> {
    return [...this.rows.values()].some((r) => r.jobId === jobId);
  }

  async listStuckSending(olderThan: Date, limit: number): Promise<MintEventRow[]> {
    return [...this.rows.values()].filter((r) => r.status === 'SENDING' && !r.txHash && r.createdAt < olderThan).slice(0, limit);
  }
}
