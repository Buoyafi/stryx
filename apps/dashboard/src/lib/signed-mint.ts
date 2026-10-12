import { apiRequest } from './api';

/** Client side of the signed-mint path: scheduling, the job list, cancel, and the per-wallet report. */

export interface SignedMintStatus {
  executionEnabled: boolean;
  retryIntervalMs: number;
  giveUpMs: number;
}

export interface SignedMintScheduleInput {
  chainId: number;
  nftContract: string;
  slug: string;
  stageUuid: string;
  wallets: Array<{ walletId: string; quantity: number }>;
  /** Per-token price the operator accepts: a signed price above it is refused at fire time. */
  maxPriceWei: string;
  simulate: boolean;
  dryRun: boolean;
  maxSpendWei: string | null;
  /** Priority fee (tip) in gwei; omitted means the network's suggestion. */
  priorityFeeGwei?: string;
  /** Dry runs only: rehearse at this time (unix ms) instead of the stage start. */
  rehearsalStartAt?: number;
  /** The stage is already live: fire straight away (real or dry run). */
  fireNow?: boolean;
}

export interface SignedMintJob {
  jobId: string;
  state: string;
  ownerId: string;
  chainId: number;
  nftContract: string;
  slug: string;
  stageUuid: string;
  stageLabel: string;
  startMs: number;
  executeAt: number;
  wallets: Array<{ walletId: string; quantity: number }>;
  totalQuantity: number;
  dryRun: boolean;
  simulate: boolean;
  rehearsal: boolean;
  /** Fired straight away on a live stage ("Mint now"). */
  immediate?: boolean;
  runStatus: string | null;
}

export type SignedAttemptStatus = 'pending' | 'skipped' | 'failed' | 'dry_run_ok' | 'broadcast' | 'confirmed' | 'reverted';

export interface SignedMintAttempt {
  walletId: string;
  walletAddress: string;
  quantity: number;
  status: SignedAttemptStatus;
  reason: string | null;
  detail: string | null;
  txHash: string | null;
  calldataMs: number | null;
  simulatedMs: number | null;
  simulateDurationMs: number | null;
  signedMs: number | null;
  broadcastMs: number | null;
  confirmedMs: number | null;
  notActiveCount: number;
  rateLimitedCount: number;
}

export interface SignedMintReport {
  run: {
    jobId: string;
    status: string;
    t0: string;
    dryRun: boolean;
    clockSkewed: boolean | null;
    clockSummary: string | null;
    notes: string | null;
  };
  attempts: SignedMintAttempt[];
}

export const getSignedMintStatus = () => apiRequest<SignedMintStatus>('/signed-mints/status');
/** Own jobs only (see lib/scheduled-mints.ts). */
export const listSignedMints = () => apiRequest<{ jobs: SignedMintJob[] }>('/signed-mints?mine=1');
export const scheduleSignedMint = (input: SignedMintScheduleInput) =>
  apiRequest<{ jobId: string; startAt: string; stageLabel: string; rehearsal: boolean; immediate?: boolean }>('/signed-mints', { method: 'POST', body: input });
export const cancelSignedMint = (jobId: string) => apiRequest<{ jobId: string; result: 'cancelled' | 'aborting' }>(`/signed-mints/${jobId}`, { method: 'DELETE' });
export const getSignedMintReport = (jobId: string) => apiRequest<SignedMintReport>(`/signed-mints/${jobId}/report`);

/** A job still to fire or firing now: its card counts down and can be cancelled. */
export function isUpcoming(job: Pick<SignedMintJob, 'state'>): boolean {
  return job.state === 'delayed' || job.state === 'waiting' || job.state === 'active';
}

/** Poll quickly while a run is close or in progress, slowly otherwise. */
export function signedRefetchInterval(jobs: readonly SignedMintJob[] | undefined, now: number): number {
  if (!jobs) return 15_000;
  const busy = jobs.some((j) => j.state === 'active' || (isUpcoming(j) && j.startMs - now <= 120_000));
  return busy ? 2_000 : 15_000;
}

/** "3 confirmed, 1 failed": only the non-zero parts, in a fixed order. */
export function attemptCounts(attempts: readonly Pick<SignedMintAttempt, 'status'>[]): string {
  const order: SignedAttemptStatus[] = ['confirmed', 'broadcast', 'dry_run_ok', 'pending', 'reverted', 'failed', 'skipped'];
  const label: Record<SignedAttemptStatus, string> = {
    confirmed: 'confirmed',
    broadcast: 'sent',
    dry_run_ok: 'dry run ok',
    pending: 'pending',
    reverted: 'reverted',
    failed: 'failed',
    skipped: 'skipped',
  };
  return order
    .map((s) => [s, attempts.filter((a) => a.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${label[s]}`)
    .join(', ');
}

/** Wallets whose attempt became `confirmed` since the previous poll. */
export function newlyConfirmed(previous: ReadonlyMap<string, SignedAttemptStatus> | null, attempts: readonly SignedMintAttempt[]): string[] {
  if (previous === null) return [];
  return attempts.filter((a) => a.status === 'confirmed' && previous.get(a.walletId) !== 'confirmed').map((a) => a.walletId);
}

/** The bot's own time for one wallet: from OpenSea handing over the calldata to the transaction being sent. */
export function botTimeMs(a: Pick<SignedMintAttempt, 'calldataMs' | 'broadcastMs' | 'simulatedMs' | 'status'>): number | null {
  if (a.calldataMs === null) return null;
  const end = a.status === 'dry_run_ok' ? a.simulatedMs : a.broadcastMs;
  return end === null ? null : end - a.calldataMs;
}

/** "Bot time 42 ms" for one wallet, or "median 42 ms (fastest 31, slowest 60)" across several. */
export function botTimeSummary(attempts: readonly SignedMintAttempt[]): string | null {
  const times = attempts.map(botTimeMs).filter((t): t is number => t !== null).sort((x, y) => x - y);
  if (times.length === 0) return null;
  if (times.length === 1) return `Bot time ${times[0]} ms`;
  const mid = Math.floor(times.length / 2);
  const median = times.length % 2 === 0 ? Math.round((times[mid - 1]! + times[mid]!) / 2) : times[mid]!;
  return `Bot time: median ${median} ms (fastest ${times[0]}, slowest ${times[times.length - 1]})`;
}

/** Plain words for the runner's reason codes. Unknown codes fall back to the server's own detail. */
export function describeAttemptReason(reason: string | null): string | null {
  if (!reason) return null;
  const known: Record<string, string> = {
    not_eligible: 'Not eligible for this stage',
    other_stage_active: 'Another stage is still active on OpenSea',
    insufficient_funds: 'Not enough funds',
    gave_up: 'Gave up waiting for the stage',
    execution_disabled: 'Signed minting is switched off',
    aborted: 'Cancelled',
    job_spend_limit: 'Over the job spend limit',
    already_sent: 'Already attempted in an earlier run',
    price_above_expected: 'Price higher than accepted',
    simulation_reverted: 'Simulation reverted',
    emergency_stop: 'Emergency stop active',
    spending_cap_exceeded: 'Daily spend cap reached',
    rpc_unavailable: 'Chain RPC unavailable',
    unsupported_chain: 'No RPC configured for this chain',
    wrong_chain: 'RPC reports a different chain',
    warmup_failed: 'Warm-up failed',
    wallet_not_found: 'Wallet not found',
    wallet_not_active: 'Wallet not active',
    unknown_signer: 'Unrecognised signer',
    outside_signer_bounds: 'Signed terms outside on-chain limits',
    fee_recipient_not_allowed: 'Fee recipient not allowed',
    wrong_quantity: 'Wrong quantity in calldata',
    wrong_minter: 'Calldata for a different wallet',
    wrong_contract: 'Calldata for a different contract',
    calldata_invalid: 'Unreadable calldata',
    unexpected_target: 'OpenSea targeted a different contract',
    reverted_onchain: 'Reverted on-chain',
    send_failed: 'Send failed',
  };
  return known[reason] ?? reason;
}
