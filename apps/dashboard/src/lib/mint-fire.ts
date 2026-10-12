import { priorityFeeBody } from './priority-fee';
import { apiRequest } from './api';
import type { Phase } from './collection-phases';
import type { WalletEligibilityRow } from './mint-eligibility';
import { OUTCOME_UNKNOWN, describeMintError, isRefusal } from './mint-error';

/**
 * Execution wiring for the mint page: Merkle and public phases only. Signed stages are scheduled
 * through their own server job.
 */

export interface EligibleSelection {
  walletId: string;
  address: string;
  priceWei: string | null;
  isMax: boolean;
  /** The best known quantity: the fixed number, or for `isMax` the wallet's own `remaining`. */
  quantity: number;
}

/** Selected wallets that are eligible and have something to mint. */
export function resolveSelection(
  selected: ReadonlySet<string>,
  quantities: Readonly<Record<string, number>>,
  maxFlags: Readonly<Record<string, boolean>>,
  rowsByWallet: ReadonlyMap<string, WalletEligibilityRow>,
): EligibleSelection[] {
  const out: EligibleSelection[] = [];
  for (const walletId of selected) {
    const row = rowsByWallet.get(walletId);
    if (!row || row.eligible !== 'eligible') continue;
    const isMax = maxFlags[walletId] ?? false;
    const quantity = isMax ? (row.remaining ?? 0) : (quantities[walletId] ?? 0);
    if (quantity <= 0) continue;
    out.push({ walletId, address: row.address, priceWei: row.priceWei, isMax, quantity });
  }
  return out;
}

export function totalCostWei(selection: readonly EligibleSelection[]): string | null {
  let total = 0n;
  let known = false;
  for (const s of selection) {
    if (s.priceWei === null) continue;
    known = true;
    total += BigInt(s.priceWei) * BigInt(s.quantity);
  }
  return known ? total.toString() : null;
}

/** The most wallets one batch mint takes (apps/api mint-batch.service.ts MAX_BATCH_WALLETS). */
export const MAX_BATCH_WALLETS = 25;

export interface QuantityGroup {
  /** The literal value MintBatchService receives: 'max' resolves per-wallet, fresh, server-side. */
  quantity: number | 'max';
  wallets: EligibleSelection[];
}

/**
 * The batch route takes one quantity per call, but this page allows a different quantity per wallet:
 * wallets are grouped by quantity.
 */
export function groupByQuantity(selection: readonly EligibleSelection[]): QuantityGroup[] {
  const groups = new Map<number | 'max', EligibleSelection[]>();
  for (const s of selection) {
    const key = s.isMax ? ('max' as const) : s.quantity;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  // A group larger than one batch takes is split: sent whole, the server refuses all of it.
  return [...groups.entries()].flatMap(([quantity, wallets]) =>
    Array.from({ length: Math.ceil(wallets.length / MAX_BATCH_WALLETS) }, (_, i) => ({ quantity, wallets: wallets.slice(i * MAX_BATCH_WALLETS, (i + 1) * MAX_BATCH_WALLETS) })),
  );
}

export interface MintFireRow {
  walletId: string;
  address: string;
  /** 'unknown': it may have gone out (no answer, or the chain could not say). Never retry it blind. */
  status: 'sent' | 'scheduled' | 'failed' | 'skipped' | 'unknown';
  quantity: number;
  hash?: `0x${string}`;
  detail?: string;
}

interface WalletMintRowLike {
  walletId: string;
  address: string;
  status: 'sent' | 'failed' | 'skipped' | 'unknown';
  quantity: number;
  hash?: `0x${string}`;
  reason?: string;
  error?: string;
}

interface BatchMintOutcomeLike {
  ok: boolean;
  preflightError?: string;
  detail?: string;
  haltReason?: string;
  results: WalletMintRowLike[];
}

/** What every fire/schedule call needs. `priorityFeeGwei` is the operator's tip; blank or absent means the network's. */
export interface MintFireContext {
  nftContract: string;
  chainId: number;
  phase: Phase;
  slug: string | null;
  priorityFeeGwei?: string;
}

function batchMintBody(quantity: number | 'max', walletIds: readonly string[], ctx: MintFireContext): Record<string, unknown> {
  const base = { nftContract: ctx.nftContract, chainId: ctx.chainId, walletIds, quantity, ...priorityFeeBody(ctx.priorityFeeGwei ?? '') };
  if (ctx.phase.kind === 'public') return { ...base, stage: 'public' };
  // Only 'merkle' reaches here: firing is enabled only for a public phase or a Merkle allow-list one.
  return { ...base, stage: 'allowlist', proofSource: 'opensea', slug: ctx.slug };
}

/** Fires one `/mints/seadrop/batch` call per quantity group, in order: a halted group stops the ones after it. */
export async function fireNow(
  ctx: MintFireContext,
  selection: readonly EligibleSelection[],
): Promise<MintFireRow[]> {
  const groups = groupByQuantity(selection);
  const rows = new Map<string, MintFireRow>();

  for (const group of groups) {
    const walletIds = group.wallets.map((w) => w.walletId);
    try {
      const outcome = await apiRequest<BatchMintOutcomeLike>('/mints/seadrop/batch', {
        method: 'POST',
        body: batchMintBody(group.quantity, walletIds, ctx),
      });
      for (const r of outcome.results) {
        rows.set(r.walletId, { walletId: r.walletId, address: r.address, status: r.status, quantity: r.quantity, hash: r.hash, detail: r.error ?? r.reason });
      }
    } catch (err) {
      // Only a refusal the server gave means nothing was sent.
      const row = isRefusal(err) ? { status: 'failed' as const, detail: describeMintError(err) } : { status: 'unknown' as const, detail: OUTCOME_UNKNOWN };
      for (const w of group.wallets) rows.set(w.walletId, { walletId: w.walletId, address: w.address, quantity: w.quantity, ...row });
    }
  }

  return selection.map((s) => rows.get(s.walletId) ?? { walletId: s.walletId, address: s.address, status: 'failed', quantity: s.quantity, detail: 'No result returned.' });
}

/** There is no batch-schedule endpoint: this calls the single-wallet route once per selected wallet. */
export async function scheduleAll(
  ctx: MintFireContext,
  selection: readonly EligibleSelection[],
): Promise<MintFireRow[]> {
  const rows: MintFireRow[] = [];
  const tip = priorityFeeBody(ctx.priorityFeeGwei ?? '');

  for (const s of selection) {
    // The price shown when scheduling is the most this mint may pay per token when it fires.
    const ceiling = s.priceWei !== null ? { maxPriceWei: s.priceWei } : {};
    try {
      if (ctx.phase.kind === 'public') {
        const r = await apiRequest<{ jobId: string }>('/schedules/mints/auto', {
          method: 'POST',
          body: { walletId: s.walletId, nftContract: ctx.nftContract, chainId: ctx.chainId, quantity: s.quantity, ...tip, ...ceiling },
        });
        rows.push({ walletId: s.walletId, address: s.address, status: 'scheduled', quantity: s.quantity, detail: `Scheduled (job ${r.jobId}).` });
        continue;
      }
      const executeAt = ctx.phase.startMs !== null ? new Date(ctx.phase.startMs).toISOString() : new Date().toISOString();
      const r = await apiRequest<{ jobId: string }>('/schedules/mints', {
        method: 'POST',
        body: { walletId: s.walletId, nftContract: ctx.nftContract, chainId: ctx.chainId, quantity: s.quantity, executeAt, kind: 'allowlist-opensea', slug: ctx.slug, ...tip, ...ceiling },
      });
      rows.push({ walletId: s.walletId, address: s.address, status: 'scheduled', quantity: s.quantity, detail: `Scheduled (job ${r.jobId}).` });
    } catch (err) {
      rows.push({ walletId: s.walletId, address: s.address, status: 'failed', quantity: s.quantity, detail: describeMintError(err) });
    }
  }

  return rows;
}
