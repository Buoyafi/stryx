import { apiRequest } from './api';
import { chargeLogo } from './brand';
import { isSuperseded, lowerHash, shouldCharge, type DeviceMint, type ReceiptInfo, type ReceiptMap, type ScheduledJob } from './mint-ops';
import type { MintFeedStore } from './mint-feed-store';

/** A transaction whose final receipt we still want. */
export interface WatchTarget {
  chainId: number;
  hash: string;
  /** Unix ms it was broadcast (or, for a scheduled job, when it was due). */
  at: number;
}

/** One entry of POST /chains/:id/transactions/receipts. */
export interface RawReceipt {
  hash: string;
  status: 'success' | 'reverted' | 'pending' | 'unknown' | 'not_found';
  gasUsed?: string;
  effectiveGasPriceWei?: string;
}

export type FetchReceipts = (chainId: number, hashes: string[], opts?: { lookup?: boolean }) => Promise<RawReceipt[]>;

/** How often to look while something is pending. */
export const RECEIPT_POLL_MS = 3_000;
/** The receipts route takes at most this many hashes per call. */
export const RECEIPT_BATCH = 50;
/** A hash still pending after this long stops being polled and shows as unconfirmed. */
export const UNCONFIRMED_AFTER_MS = 300_000;

export const fetchReceiptsFromApi: FetchReceipts = (chainId, hashes, opts) =>
  apiRequest<{ receipts: RawReceipt[] }>(`/chains/${chainId}/transactions/receipts`, { method: 'POST', body: { hashes, ...(opts?.lookup ? { lookup: true } : {}) } }).then((r) => r.receipts);

/** Every broadcast hash (device mints and scheduled jobs that ran) that has no final receipt and has not given up. */
export function pendingTargets(input: {
  device: readonly DeviceMint[];
  jobs: readonly ScheduledJob[];
  receipts: ReceiptMap;
  unconfirmed: ReadonlySet<string>;
}): WatchTarget[] {
  const targets = new Map<string, WatchTarget>();
  const want = (chainId: number, hash: string | undefined, at: number) => {
    if (!hash) return;
    const key = lowerHash(hash);
    if (input.receipts[key] || input.unconfirmed.has(key) || targets.has(key)) return;
    targets.set(key, { chainId, hash, at });
  };
  for (const m of input.device) want(m.chainId, m.hash, m.at);
  for (const j of input.jobs) {
    if (isSuperseded(j) || j.state !== 'completed' || !j.outcome?.ok) continue;
    want(j.chainId, j.outcome.hash, j.executeAt);
  }
  return [...targets.values()];
}

export interface RoundResult {
  resolved: Record<string, ReceiptInfo>;
  sawPending: string[];
  unconfirmed: string[];
  /** Asked about, no answer: the call failed, or the node said 'unknown' for it. */
  unanswered: string[];
}

/** A hash with no answer this many rounds running (about a minute) stops being asked about. */
export const MAX_UNANSWERED_ROUNDS = 20;

/** One look at the chain for every target, batched per chain. */
export async function runReceiptRound(targets: readonly WatchTarget[], fetchReceipts: FetchReceipts, now: number): Promise<RoundResult> {
  const result: RoundResult = { resolved: {}, sawPending: [], unconfirmed: [], unanswered: [] };
  const byChain = new Map<number, WatchTarget[]>();
  for (const t of targets) byChain.set(t.chainId, [...(byChain.get(t.chainId) ?? []), t]);

  for (const [chainId, chainTargets] of byChain) {
    for (let i = 0; i < chainTargets.length; i += RECEIPT_BATCH) {
      const batch = chainTargets.slice(i, i + RECEIPT_BATCH);
      let raws: RawReceipt[];
      try {
        raws = await fetchReceipts(chainId, batch.map((t) => t.hash));
      } catch {
        result.unanswered.push(...batch.map((t) => lowerHash(t.hash)));
        continue;
      }
      const answered = new Set<string>();
      for (const raw of raws) {
        const key = lowerHash(raw.hash);
        const target = batch.find((t) => lowerHash(t.hash) === key);
        if (!target) continue;
        if (raw.status === 'success' || raw.status === 'reverted') {
          answered.add(key);
          result.resolved[key] = {
            status: raw.status,
            ...(raw.gasUsed ? { gasUsed: raw.gasUsed } : {}),
            ...(raw.effectiveGasPriceWei ? { effectiveGasPriceWei: raw.effectiveGasPriceWei } : {}),
          };
        } else if (raw.status === 'pending') {
          answered.add(key);
          result.sawPending.push(key);
          if (now - target.at > UNCONFIRMED_AFTER_MS) result.unconfirmed.push(key);
        }
      }
      // 'unknown', or left out of the reply altogether.
      for (const t of batch) if (!answered.has(lowerHash(t.hash))) result.unanswered.push(lowerHash(t.hash));
    }
  }
  return result;
}

const unansweredRounds = new WeakMap<MintFeedStore, Map<string, number>>();

/**
 * One round, applied: look up receipts, record what came back, and replay the logo (once, however many
 * landed together) for confirmations this session watched happen.
 */
export async function processRound(input: {
  store: MintFeedStore;
  targets: readonly WatchTarget[];
  fetchReceipts?: FetchReceipts;
  charge?: () => void;
  now?: number;
}): Promise<number> {
  const { store, targets, fetchReceipts = fetchReceiptsFromApi, charge = chargeLogo } = input;
  const now = input.now ?? Date.now();
  if (targets.length === 0) return 0;

  const round = await runReceiptRound(targets, fetchReceipts, now);
  const before = store.getSnapshot();

  // A hash nobody can answer for was asked about every 3 seconds for as long as the page stayed open.
  const misses = unansweredRounds.get(store) ?? new Map<string, number>();
  unansweredRounds.set(store, misses);
  const asked = new Set(targets.map((t) => lowerHash(t.hash)));
  for (const hash of [...misses.keys()]) if (!asked.has(hash) || !round.unanswered.includes(hash)) misses.delete(hash);
  for (const hash of round.unanswered) {
    const count = (misses.get(hash) ?? 0) + 1;
    if (count >= MAX_UNANSWERED_ROUNDS) {
      round.unconfirmed.push(hash);
      misses.delete(hash);
    } else misses.set(hash, count);
  }

  const toCharge = Object.entries(round.resolved)
    .filter(([hash, info]) => {
      const target = targets.find((t) => lowerHash(t.hash) === hash);
      return info.status === 'success' && !!target && shouldCharge({ hash, seenPending: before.seenPending, eventAt: target.at, now, charged: before.charged });
    })
    .map(([hash]) => hash);

  store.markPending(round.sawPending);
  store.markUnconfirmed(round.unconfirmed);
  store.setReceipts(round.resolved);
  if (toCharge.length > 0) {
    store.markCharged(toCharge);
    charge();
  }

  const done = new Set([...Object.keys(round.resolved), ...round.unconfirmed]);
  return targets.filter((t) => !done.has(lowerHash(t.hash))).length;
}
