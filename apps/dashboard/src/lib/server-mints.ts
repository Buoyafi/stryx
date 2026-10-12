import { useInfiniteQuery } from '@tanstack/react-query';
import { apiRequest } from './api';
import { humanReason, lowerHash, REVERTED_ON_CHAIN, type FeedRow, type FeedStatus, type ReceiptInfo, type ReceiptMap } from './mint-ops';
import type { HistoryEntry, HistoryLeg } from './mint-history';
import { describeAttemptReason } from './signed-mint';

/** The account's own mint history, from the server's mint log (`GET /me/mints`). */

export type ServerMintStatus = 'SENDING' | 'PENDING' | 'CONFIRMED' | 'REVERTED' | 'DROPPED' | 'BLOCKED';

export interface ServerMint {
  id: string;
  walletId: string;
  walletAddress: string;
  chainId: number;
  contract: string;
  kind: 'PUBLIC' | 'ALLOWLIST' | 'SIGNED';
  quantity: number;
  source: 'MANUAL' | 'SCHEDULED' | 'API';
  jobId: string | null;
  status: ServerMintStatus;
  failureReason: string | null;
  failureNote: string | null;
  txHash: string | null;
  gasUsed: string | null;
  createdAt: string;
  broadcastAt: string | null;
}

export interface ServerMintPage {
  mints: ServerMint[];
  nextBefore: string | null;
  /** First page only: when this account's history on the server begins (null: nothing yet). */
  firstAt?: string | null;
}

export const SERVER_MINTS_KEY = ['me-mints'] as const;
export const SERVER_MINTS_PAGE = 100;
/** While anything is still waiting on the chain, look again this often; otherwise now and then. */
export const SERVER_MINTS_BUSY_MS = 8_000;
export const SERVER_MINTS_IDLE_MS = 60_000;

const WAITING: ReadonlySet<ServerMintStatus> = new Set(['SENDING', 'PENDING']);

export function useServerMints() {
  return useInfiniteQuery({
    queryKey: SERVER_MINTS_KEY,
    queryFn: ({ pageParam }) => apiRequest<ServerMintPage>(`/me/mints?limit=${SERVER_MINTS_PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.mints.some((m) => WAITING.has(m.status))) ? SERVER_MINTS_BUSY_MS : SERVER_MINTS_IDLE_MS),
    retry: false,
  });
}

const REASON_TEXT: Record<string, string> = {
  internal_error: 'Something went wrong on our side',
  interrupted: 'Interrupted before it was sent',
  no_active_public_stage: 'The public stage was not live',
};

/** A refusal before signing, in words: the known reason, then the server's short note if it has one. */
export function blockedReason(reason: string | null, note: string | null): string {
  const base = (reason && (REASON_TEXT[reason] ?? describeAttemptReason(reason) ?? humanReason(reason))) || 'Mint failed';
  return note && note !== base ? `${base}: ${note}` : base;
}

/** What a server row shows as. A receipt this browser already saw can settle a row before the server does. */
function statusOf(m: ServerMint, receipts: ReceiptMap): { status: FeedStatus; reason?: string; gasUsed?: string } {
  const gas = m.gasUsed ? { gasUsed: m.gasUsed } : {};
  switch (m.status) {
    case 'CONFIRMED':
      return { status: 'confirmed', ...gas };
    case 'REVERTED':
      return { status: 'failed', reason: REVERTED_ON_CHAIN, ...gas };
    case 'BLOCKED':
      return { status: 'failed', reason: blockedReason(m.failureReason, m.failureNote) };
    case 'DROPPED':
      return { status: 'unconfirmed', reason: 'Never mined: the network dropped it' };
    default: {
      const receipt = m.txHash ? receipts[lowerHash(m.txHash)] : undefined;
      if (receipt?.status === 'success') return { status: 'confirmed', ...(receipt.gasUsed ? { gasUsed: receipt.gasUsed } : {}) };
      if (receipt?.status === 'reverted') return { status: 'failed', reason: REVERTED_ON_CHAIN };
      return { status: 'pending' };
    }
  }
}

const rowTime = (m: ServerMint) => Date.parse(m.broadcastAt ?? m.createdAt);
const rowId = (m: ServerMint) => (m.txHash ? `tx:${lowerHash(m.txHash)}` : `mint:${m.id}`);

/** Public and allowlist rows, as the feed rows Activity groups into runs. */
/**
 * The final receipts the account's mint log already knows (the server settles every sent mint: see the
 * reconciler), for transactions this browser has none for.
 */
export function receiptsFromServer(mints: readonly ServerMint[], known: ReceiptMap): Record<string, ReceiptInfo> {
  const out: Record<string, ReceiptInfo> = {};
  for (const m of mints) {
    if (!m.txHash || (m.status !== 'CONFIRMED' && m.status !== 'REVERTED')) continue;
    const key = lowerHash(m.txHash);
    if (known[key]) continue;
    out[key] = { status: m.status === 'CONFIRMED' ? 'success' : 'reverted', ...(m.gasUsed ? { gasUsed: m.gasUsed } : {}) };
  }
  return out;
}

export function feedRowsFromServer(mints: readonly ServerMint[], receipts: ReceiptMap): FeedRow[] {
  return mints
    .filter((m) => m.kind !== 'SIGNED')
    .map((m) => ({
      id: rowId(m),
      at: rowTime(m),
      source: m.source === 'SCHEDULED' ? ('scheduled' as const) : ('device' as const),
      chainId: m.chainId,
      nftContract: m.contract,
      walletId: m.walletId,
      address: m.walletAddress,
      quantity: m.quantity,
      ...(m.txHash ? { hash: m.txHash } : {}),
      ...statusOf(m, receipts),
    }));
}

/** Signed (OpenSea GTD/FCFS) rows, one entry per run. */
export function signedEntriesFromServer(mints: readonly ServerMint[], receipts: ReceiptMap): HistoryEntry[] {
  const runs = new Map<string, HistoryEntry>();
  for (const m of mints) {
    if (m.kind !== 'SIGNED') continue;
    const id = `signed:${m.jobId ?? m.id}`;
    const { status, reason, gasUsed } = statusOf(m, receipts);
    const leg: HistoryLeg = {
      id: `${m.walletId}:${m.txHash ?? m.id}`,
      walletId: m.walletId,
      address: m.walletAddress,
      status,
      quantity: m.quantity,
      ...(m.txHash ? { hash: m.txHash } : {}),
      ...(reason ? { reason } : {}),
      ...(gasUsed ? { gasUsed } : {}),
    };
    const at = Date.parse(m.createdAt);
    const run = runs.get(id);
    if (run) {
      run.legs.push(leg);
      run.at = Math.min(run.at, at);
    } else {
      runs.set(id, { id, kind: 'signed', at, chainId: m.chainId, nftContract: m.contract, ...(m.jobId ? { jobId: m.jobId } : {}), legs: [leg] });
    }
  }
  return [...runs.values()];
}

/**
 * Signed runs from both places, one per run: the report (with how fast each wallet landed) while the
 * server still holds it and it has loaded, the mint log otherwise.
 */
export function mergeSigned(fromReports: readonly HistoryEntry[], fromLog: readonly HistoryEntry[]): HistoryEntry[] {
  const byId = new Map(fromLog.map((e) => [e.id, e]));
  for (const e of fromReports) {
    if (e.loading && byId.has(e.id)) continue;
    byId.set(e.id, e);
  }
  return [...byId.values()];
}

/** This browser's own records that the server cannot have: those from before the account's first row on the server. */
export function olderLocalRows(local: readonly FeedRow[], firstAt: string | null | undefined, server: readonly FeedRow[]): FeedRow[] {
  const cutoff = firstAt ? Date.parse(firstAt) : Number.POSITIVE_INFINITY;
  const known = new Set(server.map((r) => r.id));
  return local.filter((r) => r.at < cutoff && !known.has(r.id));
}
