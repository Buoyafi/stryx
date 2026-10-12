/**
 * Pure logic for Mint history: turns recorded mints and finished signed-mint runs into one list of
 * runs, each with its per-wallet legs.
 */

import type { FeedRow, FeedStatus } from './mint-ops';
import { describeAttemptReason, type SignedMintAttempt, type SignedMintJob, type SignedMintReport } from './signed-mint';

export type HistoryFilter = 'all' | 'success' | 'failed';

export const HISTORY_FILTERS: readonly { value: HistoryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Successful' },
  { value: 'failed', label: 'Failed' },
];

export interface HistoryLeg {
  id: string;
  walletId: string;
  address?: string;
  status: FeedStatus;
  hash?: string;
  reason?: string;
  quantity?: number;
  gasUsed?: string;
  /** Signed runs only: ms after the stage opened that this wallet's mint landed (confirmed, else sent). */
  landedMs?: number;
}

export interface HistoryEntry {
  id: string;
  kind: 'signed' | 'scheduled' | 'direct';
  /** Unix ms: when it ran (scheduled or signed) or was fired (direct). */
  at: number;
  chainId: number;
  nftContract: string;
  stageLabel?: string;
  jobId?: string;
  legs: HistoryLeg[];
  /** Signed runs whose per-wallet report has not loaded yet: shown in All, counted under no filter. */
  loading?: boolean;
}

export interface HistoryCounts {
  confirmed: number;
  failed: number;
  pending: number;
}

export function countLegs(legs: readonly HistoryLeg[]): HistoryCounts {
  const counts = { confirmed: 0, failed: 0, pending: 0 };
  for (const leg of legs) {
    if (leg.status === 'confirmed') counts.confirmed++;
    else if (leg.status === 'failed') counts.failed++;
    else counts.pending++;
  }
  return counts;
}

export function totalQuantity(entry: HistoryEntry): number {
  return entry.legs.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
}

export function matchesFilter(entry: HistoryEntry, filter: HistoryFilter): boolean {
  if (filter === 'all') return true;
  if (entry.loading) return false;
  const counts = countLegs(entry.legs);
  return filter === 'success' ? counts.confirmed > 0 : counts.failed > 0;
}

/** The pill: "9 of 9 confirmed", "2 of 3 confirmed", "failed", "pending". */
export function outcomeOf(entry: HistoryEntry): { cls: 'live' | 'pending' | 'fail' | 'idle'; label: string } {
  if (entry.loading) return { cls: 'idle', label: 'loading' };
  const { confirmed, failed, pending } = countLegs(entry.legs);
  const total = entry.legs.length;
  if (total === 0) return { cls: 'idle', label: 'no result' };
  if (confirmed === total) return { cls: 'live', label: total === 1 ? 'confirmed' : `${total} of ${total} confirmed` };
  if (confirmed > 0) return { cls: 'pending', label: `${confirmed} of ${total} confirmed` };
  if (failed > 0 && pending === 0) return { cls: 'fail', label: total === 1 ? 'failed' : `${failed} failed` };
  return { cls: 'idle', label: 'pending' };
}

/** The first failure reason in the run, for the collapsed card. */
export function firstReason(entry: HistoryEntry): string | undefined {
  return entry.legs.find((l) => l.status === 'failed' && l.reason)?.reason;
}

/** Rows recorded within this long of each other, for one collection and source, are one run. */
export const RUN_WINDOW_MS = 10 * 60_000;

function legFromRow(row: FeedRow): HistoryLeg {
  return {
    id: row.id,
    walletId: row.walletId,
    status: row.status,
    ...(row.address ? { address: row.address } : {}),
    ...(row.hash ? { hash: row.hash } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.quantity !== undefined ? { quantity: row.quantity } : {}),
    ...(row.gasUsed ? { gasUsed: row.gasUsed } : {}),
  };
}

/**
 * Groups the device feed's rows into runs: same chain, contract and source (scheduled or fired from
 * this device), within RUN_WINDOW_MS of the run's first row.
 */
export function entriesFromRows(rows: readonly FeedRow[]): HistoryEntry[] {
  const sorted = [...rows].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  const entries: HistoryEntry[] = [];
  const open = new Map<string, HistoryEntry>();
  for (const row of sorted) {
    const key = `${row.chainId}:${row.nftContract.toLowerCase()}:${row.source}`;
    const current = open.get(key);
    if (current && current.at - row.at <= RUN_WINDOW_MS) {
      current.legs.push(legFromRow(row));
      current.at = row.at;
      continue;
    }
    const entry: HistoryEntry = {
      id: `run:${row.id}`,
      kind: row.source === 'scheduled' ? 'scheduled' : 'direct',
      at: row.at,
      chainId: row.chainId,
      nftContract: row.nftContract,
      legs: [legFromRow(row)],
    };
    entries.push(entry);
    open.set(key, entry);
  }
  return entries;
}

function legFromAttempt(a: SignedMintAttempt): HistoryLeg {
  const status: FeedStatus =
    a.status === 'confirmed' ? 'confirmed' : a.status === 'broadcast' || a.status === 'pending' ? 'pending' : 'failed';
  const reason = status === 'failed' ? (a.status === 'reverted' ? 'Reverted on-chain' : describeAttemptReason(a.reason) ?? a.detail ?? a.status) : undefined;
  const landed = a.confirmedMs ?? a.broadcastMs;
  return {
    id: `${a.walletId}:${a.txHash ?? a.status}`,
    walletId: a.walletId,
    ...(a.walletAddress ? { address: a.walletAddress } : {}),
    status,
    quantity: a.quantity,
    ...(a.txHash ? { hash: a.txHash } : {}),
    ...(reason ? { reason } : {}),
    ...(landed !== null ? { landedMs: landed } : {}),
  };
}

/** Whether a signed job belongs in history at all: it really ran (not a rehearsal, not cancelled or moved). */
export function isHistoricalSignedJob(job: SignedMintJob): boolean {
  if (job.dryRun) return false;
  if (job.state === 'delayed' || job.state === 'waiting' || job.state === 'active') return false;
  if (job.runStatus === 'cancelled' || job.runStatus === 'aborted' || job.runStatus === 'moved') return false;
  return true;
}

/** One signed run as a history entry. Without its report yet, it is `loading` (or a bare failure if the job itself failed). */
export function entryFromSignedJob(job: SignedMintJob, report?: SignedMintReport): HistoryEntry {
  const base = {
    id: `signed:${job.jobId}`,
    kind: 'signed' as const,
    at: job.startMs,
    chainId: job.chainId,
    nftContract: job.nftContract,
    stageLabel: job.stageLabel,
    jobId: job.jobId,
  };
  if (report) return { ...base, legs: report.attempts.map(legFromAttempt) };
  if (job.state === 'failed') {
    return { ...base, legs: [{ id: `signed:${job.jobId}:failed`, walletId: '', status: 'failed', reason: 'The run failed before any wallet was sent.' }] };
  }
  return { ...base, legs: [], loading: true };
}

/** Newest first. */
export function buildHistory(input: { rows: readonly FeedRow[]; signed: readonly HistoryEntry[] }): HistoryEntry[] {
  return [...entriesFromRows(input.rows), ...input.signed].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}
