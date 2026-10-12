import type { QueryClient } from '@tanstack/react-query';
import { apiRequest } from './api';

/**
 * Every balance the dashboard shows lives under one query-key root, `['balances', …]`: per wallet (all
 * chains) and per chain (every wallet), so one invalidation reaches both.
 */
export const balanceKeys = {
  all: ['balances'] as const,
  chains: ['balances', 'chain'] as const,
  wallet: (walletId: string) => ['balances', 'wallet', walletId] as const,
  chain: (chainId: string | number) => ['balances', 'chain', String(chainId)] as const,
};

/** How long a picker's per-chain balance list counts as fresh. */
export const PICKER_BALANCE_STALE_MS = 5_000;

/** What a transaction (or batch) changed on-chain: refresh exactly these. */
export interface AffectedBalances {
  chainId: string | number;
  walletIds: readonly string[];
}

/** Marks the affected wallets' balances, and the chain's picker list, as needing a re-read. */
export async function invalidateBalances(qc: QueryClient, affected: AffectedBalances): Promise<void> {
  await Promise.all([
    ...[...new Set(affected.walletIds)].map((id) => qc.invalidateQueries({ queryKey: balanceKeys.wallet(id) })),
    qc.invalidateQueries({ queryKey: balanceKeys.chain(affected.chainId) }),
  ]);
}

/** A wallet was added, so every picker's per-chain list is missing it and would show it as "0". */
export function invalidateWalletListBalances(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: balanceKeys.chains });
}

/** Refetches a chain's picker balances only if they have gone stale. */
export function refetchStaleChainBalances(qc: QueryClient, chainId: string | number): Promise<void> {
  return qc.refetchQueries({ queryKey: balanceKeys.chain(chainId), stale: true }, { cancelRefetch: false });
}

// Waiting for the chain to actually change

export type TxStatus = 'pending' | 'success' | 'reverted';

export function fetchTransactionStatus(chainId: string | number, hash: string): Promise<TxStatus> {
  return apiRequest<{ status: TxStatus }>(`/chains/${chainId}/transactions/${hash}`).then((r) => r.status);
}

/** What happened to a tracked broadcast: drives the status line shown next to the action's result. */
export type TrackOutcome = 'nothing_sent' | 'confirmed' | 'reverted' | 'unconfirmed';

export interface BroadcastToTrack extends AffectedBalances {
  /** Hashes from ONE sender, in the order they were sent. */
  hashes: readonly string[];
}

export interface TrackOptions {
  fetchStatus?: (chainId: string | number, hash: string) => Promise<TxStatus>;
  intervalMs?: number;
  timeoutMs?: number;
}

/** Refreshes balances once a sent transaction has been mined, not when it was merely sent. */
export async function trackBroadcast(
  qc: QueryClient,
  tx: BroadcastToTrack,
  opts: TrackOptions = {},
): Promise<TrackOutcome> {
  const { fetchStatus = fetchTransactionStatus, intervalMs = 2_000, timeoutMs = 120_000 } = opts;

  const last = tx.hashes[tx.hashes.length - 1];
  if (last === undefined) return 'nothing_sent';

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: TxStatus = 'pending';
    try {
      status = await fetchStatus(tx.chainId, last);
    } catch {
      // Transient lookup failure: same as "not yet"; the deadline bounds this.
    }

    if (status !== 'pending') {
      await invalidateBalances(qc, tx);
      return status === 'success' ? 'confirmed' : 'reverted';
    }
    if (Date.now() + intervalMs >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  await invalidateBalances(qc, tx);
  return 'unconfirmed';
}

/** The status line shown beside a broadcast's result, or null when there's nothing to say. */
export function describeTrackOutcome(outcome: TrackOutcome | 'confirming' | 'idle'): { text: string; tone: 'dim' | 'live' | 'pending' | 'fail' } | null {
  switch (outcome) {
    case 'confirming':
      return { text: 'Confirming on-chain… balances refresh once mined.', tone: 'dim' };
    case 'confirmed':
      return { text: 'Confirmed on-chain. Balances updated.', tone: 'live' };
    case 'reverted':
      return { text: 'Reverted on-chain. Only gas was spent.', tone: 'fail' };
    case 'unconfirmed':
      return {
        text: 'Not confirmed in 2 min. It may still be pending. Balances may be stale.',
        tone: 'pending',
      };
    case 'nothing_sent':
    case 'idle':
      return null;
  }
}
