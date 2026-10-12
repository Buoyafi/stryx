import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChainView, TooltipRow } from '@stryx/chain-ui';
import { balanceKeys } from './balance-cache';

export type BalanceRead = 'ok' | 'failed';

/** One cached query, reduced to what this file reads. */
export interface CacheEntry {
  key: readonly unknown[];
  data: unknown;
  updatedAt: number;
}

interface WithBalances {
  balances?: { chainId?: number; error?: string }[];
}

/**
 * Whether the most recent balance read covering `chainId` succeeded, judged only from queries already
 * in the cache: no request is made for it.
 */
export function lastBalanceRead(chainId: number, entries: readonly CacheEntry[]): BalanceRead | undefined {
  let newest: { at: number; read: BalanceRead } | undefined;
  for (const { key, data, updatedAt } of entries) {
    const list = (data as WithBalances | undefined)?.balances;
    if (!Array.isArray(list) || list.length === 0) continue;
    let read: BalanceRead | undefined;
    if (key[1] === 'wallet') {
      const mine = list.filter((b) => b.chainId === chainId);
      if (mine.length > 0) read = mine.some((b) => b.error) ? 'failed' : 'ok';
    } else if (key[1] === 'chain' && String(key[2]) === String(chainId)) {
      read = list.some((b) => b.error) ? 'failed' : 'ok';
    }
    if (read && (!newest || updatedAt > newest.at)) newest = { at: updatedAt, read };
  }
  return newest?.read;
}

export interface ChainSnapshot {
  /** Chain ids the API says have an RPC configured, or undefined if not loaded yet. */
  configuredChainIds: readonly number[] | undefined;
  /** Whether /health answered ok, or undefined if not known yet. */
  apiOk: boolean | undefined;
  balanceRead: BalanceRead | undefined;
}

/** The extra tooltip rows the dashboard adds on top of the static registry facts. */
export function chainStatusRows(chainId: number, snap: ChainSnapshot): TooltipRow[] {
  const rows: TooltipRow[] = [];
  if (snap.apiOk !== undefined) {
    rows.push({ label: 'API', value: snap.apiOk ? 'Connected' : 'Unreachable', tone: snap.apiOk ? 'ok' : 'fail' });
  }
  if (snap.configuredChainIds) {
    const configured = snap.configuredChainIds.includes(chainId);
    rows.push({ label: 'RPC', value: configured ? 'Configured' : 'Not configured', tone: configured ? 'ok' : 'idle' });
  }
  if (snap.balanceRead) {
    rows.push({ label: 'Balance read', value: snap.balanceRead === 'ok' ? 'OK' : 'Failed', tone: snap.balanceRead === 'ok' ? 'ok' : 'fail' });
  }
  return rows;
}

/** A function that, called when a tooltip opens, reads the query cache and returns its extra rows. */
export function useChainStatusRows(): (chain: ChainView) => TooltipRow[] {
  const qc = useQueryClient();
  return useCallback(
    (chain) => {
      const chains = qc.getQueryData<{ chains: { chainId: number }[] }>(['chains']);
      const health = qc.getQueryState<{ status: string }>(['health']);
      const apiOk = health?.data ? health.data.status === 'ok' : health?.status === 'error' ? false : undefined;
      const entries = qc.getQueryCache().findAll({ queryKey: balanceKeys.all }).map((q) => ({
        key: q.queryKey,
        data: q.state.data,
        updatedAt: q.state.dataUpdatedAt,
      }));
      return chainStatusRows(chain.chainId, {
        configuredChainIds: chains?.chains.map((c) => c.chainId),
        apiOk,
        balanceRead: lastBalanceRead(chain.chainId, entries),
      });
    },
    [qc],
  );
}
