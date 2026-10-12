/**
 * Pure logic for the mint operations view: turns the scheduler's per-wallet jobs into countdown cards,
 * and jobs plus recorded mints into a feed.
 */

import { redactUrls, shortError } from './short-error';

/** One scheduled job, as GET /schedules/mints returns it. There is one job per wallet. */
export interface ScheduledJob {
  jobId: string;
  kind: string;
  /** BullMQ's state: delayed, waiting, active, completed or failed. */
  state: string;
  walletId: string;
  nftContract: string;
  chainId: number;
  quantity: number;
  /** Unix ms the job is due. */
  executeAt: number;
  autoRescheduleRemaining?: number;
  failedReason?: string;
  /** What the mint attempt came to, once the job has run (see apps/api mint-scheduler.ts). */
  outcome?: { ok: boolean; reason?: string; hash?: string; detail?: string };
}

export type ReceiptStatus = 'success' | 'reverted';

export interface ReceiptInfo {
  status: ReceiptStatus;
  gasUsed?: string;
  effectiveGasPriceWei?: string;
}

/** Final receipts by lowercased transaction hash. Only success and reverted are ever stored. */
export type ReceiptMap = Readonly<Record<string, ReceiptInfo | undefined>>;

/** The lifecycle a card shows. */
export type OpsState = 'scheduled' | 'armed' | 'minting' | 'confirmed' | 'failed' | 'finished';

/** A job is "armed" (and its countdown pulses) for this long before it fires. */
export const FINAL_MINUTE_MS = 60_000;
/** Jobs of one batch are added one request at a time, so their due times differ by milliseconds. */
export const GROUP_WINDOW_MS = 5_000;

export const lowerHash = (hash: string): string => hash.toLowerCase();

/** A row id for a job that never broadcast. */
export const jobRowId = (job: Pick<ScheduledJob, 'jobId' | 'executeAt'>): string => `job:${job.jobId}@${job.executeAt}`;

export function phaseOf(kind: string): 'public' | 'allowlist' {
  return kind === 'public' ? 'public' : 'allowlist';
}

/** An auto-scheduled job that fired before its stage was live and queued a new job for the moved start time. */
export function isSuperseded(job: ScheduledJob): boolean {
  return (
    job.state === 'completed' &&
    job.outcome?.ok === false &&
    job.outcome.reason === 'no_active_public_stage' &&
    (job.autoRescheduleRemaining ?? 0) > 0
  );
}

export function isFinalMinute(now: number, executeAt: number): boolean {
  const left = executeAt - now;
  return left > 0 && left <= FINAL_MINUTE_MS;
}

export function jobState(job: ScheduledJob, now: number, receipts: ReceiptMap): OpsState {
  switch (job.state) {
    case 'failed':
      return 'failed';
    case 'active':
    case 'waiting':
      return 'minting';
    case 'completed': {
      const outcome = job.outcome;
      if (!outcome) return 'finished';
      if (!outcome.ok) return 'failed';
      if (!outcome.hash) return 'finished';
      const receipt = receipts[lowerHash(outcome.hash)];
      if (receipt?.status === 'success') return 'confirmed';
      if (receipt?.status === 'reverted') return 'failed';
      return 'minting'; // broadcast, receipt not seen yet
    }
    default: {
      // delayed (or anything unrecognised that has not run)
      if (now >= job.executeAt) return 'minting';
      return isFinalMinute(now, job.executeAt) ? 'armed' : 'scheduled';
    }
  }
}

/** snake_case failure reasons from the API, as a sentence start. */
export function humanReason(reason: string): string {
  const text = reason.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Why a job failed, in the backend's own words where it has them. Undefined if it did not fail. */
export function failureReason(job: ScheduledJob, receipts: ReceiptMap): string | undefined {
  if (job.state === 'failed') return redactUrls(job.failedReason ?? 'Job failed');
  if (job.state !== 'completed' || !job.outcome) return undefined;
  if (!job.outcome.ok) {
    const base = humanReason(job.outcome.reason ?? 'mint failed');
    return job.outcome.detail ? redactUrls(`${base}: ${job.outcome.detail}`) : base;
  }
  if (job.outcome.hash && receipts[lowerHash(job.outcome.hash)]?.status === 'reverted') return REVERTED_ON_CHAIN;
  return undefined;
}

/** The receipt endpoint reports that a transaction reverted, but not why. */
export const REVERTED_ON_CHAIN = 'Reverted on-chain (reason not available)';

export type StateCounts = Record<OpsState, number>;

export interface MintCard {
  /** Stable while the group's membership is: the smallest job id in it. */
  id: string;
  chainId: number;
  nftContract: string;
  phase: 'public' | 'allowlist';
  /** Earliest due time in the group (unix ms). */
  executeAt: number;
  jobs: ScheduledJob[];
  walletIds: string[];
  state: OpsState;
  counts: StateCounts;
  /** Nothing in it has started, so it can still be cancelled. */
  cancellable: boolean;
  /** Every job has reached an end state. */
  done: boolean;
  /** The first failure reason found in the group, if any. */
  failure?: string;
}

const emptyCounts = (): StateCounts => ({ scheduled: 0, armed: 0, minting: 0, confirmed: 0, failed: 0, finished: 0 });

/** One headline state for a card. */
export function cardState(counts: StateCounts): OpsState {
  if (counts.minting > 0) return 'minting';
  if (counts.armed > 0) return 'armed';
  if (counts.scheduled > 0) return 'scheduled';
  if (counts.failed > 0) return 'failed';
  if (counts.finished > 0) return 'finished';
  return 'confirmed';
}

/**
 * Groups the scheduler's per-wallet jobs into cards: same chain, contract and phase, due within
 * GROUP_WINDOW_MS of each other.
 */
export function groupJobs(jobs: readonly ScheduledJob[], now: number, receipts: ReceiptMap): MintCard[] {
  const live = jobs
    .filter((j) => !isSuperseded(j))
    .slice()
    .sort((a, b) => {
      const ka = `${a.chainId}:${a.nftContract.toLowerCase()}:${phaseOf(a.kind)}`;
      const kb = `${b.chainId}:${b.nftContract.toLowerCase()}:${phaseOf(b.kind)}`;
      return ka === kb ? a.executeAt - b.executeAt : ka < kb ? -1 : 1;
    });

  const groups: ScheduledJob[][] = [];
  let anchor: ScheduledJob | undefined;
  for (const job of live) {
    const sameGroup =
      anchor !== undefined &&
      anchor.chainId === job.chainId &&
      anchor.nftContract.toLowerCase() === job.nftContract.toLowerCase() &&
      phaseOf(anchor.kind) === phaseOf(job.kind) &&
      job.executeAt - anchor.executeAt <= GROUP_WINDOW_MS;
    if (sameGroup) {
      groups[groups.length - 1]!.push(job);
    } else {
      groups.push([job]);
      anchor = job;
    }
  }

  const cards = groups.map((group): MintCard => {
    const counts = emptyCounts();
    let failure: string | undefined;
    for (const job of group) {
      counts[jobState(job, now, receipts)]++;
      failure ??= failureReason(job, receipts);
    }
    const first = group[0]!;
    return {
      id: group.map((j) => j.jobId).sort()[0]!,
      chainId: first.chainId,
      nftContract: first.nftContract,
      phase: phaseOf(first.kind),
      executeAt: Math.min(...group.map((j) => j.executeAt)),
      jobs: group,
      walletIds: [...new Set(group.map((j) => j.walletId))],
      state: cardState(counts),
      counts,
      cancellable: group.every((j) => j.state === 'delayed' || j.state === 'waiting') && group.every((j) => j.executeAt > now),
      done: counts.scheduled + counts.armed + counts.minting === 0,
      ...(failure ? { failure } : {}),
    };
  });

  return cards.sort((a, b) => (a.done !== b.done ? (a.done ? 1 : -1) : a.done ? b.executeAt - a.executeAt : a.executeAt - b.executeAt));
}

export function stateAppearance(state: OpsState): { cls: 'live' | 'pending' | 'fail' | 'idle'; label: string } {
  switch (state) {
    case 'confirmed':
      return { cls: 'live', label: 'confirmed' };
    case 'failed':
      return { cls: 'fail', label: 'failed' };
    case 'minting':
      return { cls: 'pending', label: 'minting' };
    case 'armed':
      return { cls: 'pending', label: 'armed' };
    case 'finished':
      return { cls: 'idle', label: 'finished' };
    default:
      return { cls: 'idle', label: 'scheduled' };
  }
}

// ---------------------------------------------------------------- feed

/** A mint fired from this dashboard, recorded in this browser (see mint-feed-store.ts). */
export interface DeviceMint {
  id: string;
  /** Unix ms it was broadcast (or attempted). */
  at: number;
  chainId: number;
  nftContract: string;
  walletId: string;
  address: string;
  quantity: number;
  /** Absent when the attempt failed before anything was broadcast. */
  hash?: string;
  /** Why it failed before broadcast, in the backend's words. */
  error?: string;
  /** Set when this was recorded from a scheduled job's outcome rather than fired from this device. */
  source?: 'scheduled';
}

export type FeedStatus = 'pending' | 'confirmed' | 'failed' | 'unconfirmed';

export interface FeedRow {
  id: string;
  at: number;
  source: 'device' | 'scheduled';
  chainId: number;
  nftContract: string;
  walletId: string;
  address?: string;
  hash?: string;
  status: FeedStatus;
  gasUsed?: string;
  reason?: string;
  quantity?: number;
}

function hashStatus(hash: string, receipts: ReceiptMap, unconfirmed: ReadonlySet<string>): { status: FeedStatus; gasUsed?: string; reason?: string } {
  const key = lowerHash(hash);
  const receipt = receipts[key];
  if (receipt?.status === 'success') return { status: 'confirmed', ...(receipt.gasUsed ? { gasUsed: receipt.gasUsed } : {}) };
  if (receipt?.status === 'reverted') return { status: 'failed', reason: REVERTED_ON_CHAIN, ...(receipt.gasUsed ? { gasUsed: receipt.gasUsed } : {}) };
  return { status: unconfirmed.has(key) ? 'unconfirmed' : 'pending' };
}

/** The feed: mints fired from this device plus the outcomes of scheduled jobs, newest first. */
export function buildFeed(input: {
  device: readonly DeviceMint[];
  jobs: readonly ScheduledJob[];
  receipts: ReceiptMap;
  unconfirmed: ReadonlySet<string>;
  addressOf: (walletId: string) => string | undefined;
}): FeedRow[] {
  const { device, jobs, receipts, unconfirmed, addressOf } = input;
  const rows = new Map<string, FeedRow>();

  for (const m of device) {
    const address = m.address || addressOf(m.walletId);
    const base = { at: m.at, source: m.source ?? ('device' as const), chainId: m.chainId, nftContract: m.nftContract, walletId: m.walletId, ...(address ? { address } : {}), quantity: m.quantity };
    if (m.hash) {
      rows.set(`tx:${lowerHash(m.hash)}`, { id: `tx:${lowerHash(m.hash)}`, ...base, hash: m.hash, ...hashStatus(m.hash, receipts, unconfirmed) });
    } else {
      rows.set(m.id, { id: m.id, ...base, status: 'failed', reason: m.error ?? 'Mint failed' });
    }
  }

  for (const job of jobs) {
    if (isSuperseded(job)) continue;
    const address = addressOf(job.walletId);
    const base = { at: job.executeAt, source: 'scheduled' as const, chainId: job.chainId, nftContract: job.nftContract, walletId: job.walletId, quantity: job.quantity, ...(address ? { address } : {}) };
    if (job.state === 'completed' && job.outcome?.ok && job.outcome.hash) {
      const id = `tx:${lowerHash(job.outcome.hash)}`;
      if (!rows.has(id)) rows.set(id, { id, ...base, hash: job.outcome.hash, ...hashStatus(job.outcome.hash, receipts, unconfirmed) });
    } else if (job.state === 'failed' || (job.state === 'completed' && job.outcome && !job.outcome.ok)) {
      const id = jobRowId(job);
      rows.set(id, { id, ...base, status: 'failed', reason: failureReason(job, receipts) ?? 'Mint failed' });
    }
  }

  return [...rows.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

/** A confirmation only counts as "just happened" if it is this recent when first seen. */
export const RECENT_CONFIRMATION_MS = 180_000;

/** Whether seeing a successful receipt for `hash` should replay the logo. */
export function shouldCharge(input: { hash: string; seenPending: ReadonlySet<string>; eventAt: number; now: number; charged: Readonly<Record<string, true>> }): boolean {
  const key = lowerHash(input.hash);
  if (input.charged[key]) return false;
  return input.seenPending.has(key) || input.now - input.eventAt <= RECENT_CONFIRMATION_MS;
}

/** The slice of a mint result row this file needs (the Mint page's WalletMintRow). */
export interface BatchResultRow {
  walletId: string;
  address: string;
  status: 'sent' | 'failed' | 'skipped' | 'unknown';
  quantity: number;
  hash?: string;
  error?: string;
}

/**
 * The mints to remember from one batch response: every broadcast one, and every one that failed before
 * broadcast (with the backend's reason).
 */
export function deviceMintsFromResults(results: readonly BatchResultRow[], ctx: { chainId: number; nftContract: string; now: number }): DeviceMint[] {
  const out: DeviceMint[] = [];
  for (const r of results) {
    const base = { at: ctx.now, chainId: ctx.chainId, nftContract: ctx.nftContract, walletId: r.walletId, address: r.address, quantity: r.quantity };
    if ((r.status === 'sent' || r.status === 'unknown') && r.hash) out.push({ id: `tx:${lowerHash(r.hash)}`, ...base, hash: r.hash });
    else if (r.status === 'failed') out.push({ id: `fail:${ctx.now}:${r.walletId}`, ...base, error: r.error ?? 'Mint failed' });
  }
  return out;
}

/** The scheduled jobs that have RUN, as records this device can keep. */
export function scheduledOutcomeRecords(jobs: readonly ScheduledJob[], receipts: ReceiptMap = {}): DeviceMint[] {
  const out: DeviceMint[] = [];
  for (const job of jobs) {
    if (isSuperseded(job)) continue;
    const base = { at: job.executeAt, chainId: job.chainId, nftContract: job.nftContract, walletId: job.walletId, address: '', quantity: job.quantity, source: 'scheduled' as const };
    if (job.state === 'completed' && job.outcome?.ok && job.outcome.hash) {
      out.push({ id: `tx:${lowerHash(job.outcome.hash)}`, ...base, hash: job.outcome.hash });
    } else if (job.state === 'failed' || (job.state === 'completed' && job.outcome && !job.outcome.ok)) {
      out.push({ id: jobRowId(job), ...base, error: shortError(failureReason(job, receipts) ?? 'Mint failed', 200) });
    }
  }
  return out;
}
