import { chainById } from '@stryx/chains';
import { apiRequest } from './api';
import { formatUnits } from './wei-format';
import { MAX_PRIORITY_FEE_GWEI } from './priority-fee';

/** Mirrors apps/api/src/tip-suggestion.service.ts. Wei amounts are decimal strings. */
export interface TipStats {
  mints: number;
  minWei: string;
  medianWei: string;
  p90Wei: string;
  maxWei: string;
}

export type PhaseOpening =
  | { startMs: number; status: 'ok'; firstBlock: TipStats & { number: string; secondsAfterStart: number }; opening: TipStats & { seconds: number; blocks: number; sampled: boolean } }
  | { startMs: number; status: 'quiet'; seconds: number; blocks: number }
  | { startMs: number; status: 'not_started' | 'too_old' | 'unavailable' };

export interface TipSuggestion {
  chainId: number;
  network: { blocks: number; typicalWei: string; busyWei: string; topWei: string; nextBaseFeeWei: string | null } | null;
  phases: PhaseOpening[];
  fetchedAt: number;
}

/** A phase of this drop the server can look back at: one that has already opened. */
export interface PastPhase {
  name: string;
  startMs: number;
}

/** The API reads at most this many earlier phases. */
export const MAX_PAST_PHASES = 3;

/** The phases that have opened, most recent first, at most three. */
export function pastPhases(phases: readonly { name: string; startMs: number | null }[], now: number): PastPhase[] {
  return phases
    .filter((p): p is PastPhase => p.startMs !== null && p.startMs <= now)
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, MAX_PAST_PHASES);
}

export function fetchTipSuggestion(chainId: number, contract: string | null, phases: readonly PastPhase[]): Promise<TipSuggestion> {
  const q = new URLSearchParams();
  if (contract) q.set('contract', contract);
  if (contract && phases.length > 0) q.set('starts', phases.map((p) => p.startMs).join(','));
  const qs = q.toString();
  return apiRequest<TipSuggestion>(`/chains/${chainId}/priority-fee/suggestion${qs ? `?${qs}` : ''}`);
}

/**
 * Wei to a gwei string with two significant figures, rounded up: a suggestion rounded down would land
 * just under the bid it is meant to beat.
 */
export function roundUpGwei(wei: bigint): string {
  if (wei <= 0n) return '0';
  const digits = wei.toString().length;
  if (digits <= 2) return formatUnits(wei.toString(), 9);
  const unit = 10n ** BigInt(digits - 2);
  const up = ((wei + unit - 1n) / unit) * unit;
  return formatUnits(up.toString(), 9);
}

/** Wei to gwei for display: three significant figures, no rounding up. */
export function showGwei(wei: string): string {
  const n = Number(formatUnits(wei, 9));
  if (n === 0) return '0';
  return n >= 100 ? String(Math.round(n)) : String(Number(n.toPrecision(3)));
}

export interface TipChoice {
  key: string;
  label: string;
  /** What goes into the field. */
  gwei: string;
  why: string;
}

const tenPercentOver = (wei: bigint) => wei + (wei + 9n) / 10n;

/** The one-tap choices under the Suggest button, strongest evidence first. */
export function tipChoices(s: TipSuggestion, chainId: number, phases: readonly PastPhase[]): TipChoice[] {
  const floor = chainById(chainId)?.feeMarket.minPriorityFeeGwei ?? null;
  const out: TipChoice[] = [];
  const add = (key: string, label: string, wei: bigint, why: string) => {
    if (wei <= 0n) return;
    let gwei = roundUpGwei(wei);
    if (floor !== null && Number(gwei) < floor) gwei = String(floor);
    if (Number(gwei) > MAX_PRIORITY_FEE_GWEI) gwei = String(MAX_PRIORITY_FEE_GWEI);
    if (out.some((c) => c.gwei === gwei)) return;
    out.push({ key, label, gwei, why });
  };

  const nameOf = (startMs: number) => phases.find((p) => p.startMs === startMs)?.name ?? 'the last phase';
  const latest = s.phases.find((p): p is Extract<PhaseOpening, { status: 'ok' }> => p.status === 'ok');
  if (latest) {
    const name = nameOf(latest.startMs);
    add('beat', 'Get ahead', tenPercentOver(BigInt(latest.firstBlock.maxWei)), `10% above the highest tip in the first block of ${name}.`);
    add('match', 'Match the pack', BigInt(latest.firstBlock.medianWei), `What the middle winner paid in the first block of ${name}.`);
  }
  if (s.network) {
    add('busy', 'Above most', BigInt(s.network.busyWei), 'Above 90% of tips in a typical recent block on this chain.');
    add('top', 'Top 1%', BigInt(s.network.topWei), 'What the top 1% tipped in a typical recent block.');
  }
  return out;
}

/** One line per earlier phase, saying what its opening showed. */
export function phaseLine(p: PhaseOpening, phases: readonly PastPhase[]): string {
  const name = phases.find((x) => x.startMs === p.startMs)?.name ?? 'Earlier phase';
  switch (p.status) {
    case 'ok': {
      const f = p.firstBlock;
      const range = f.minWei === f.maxWei ? `${showGwei(f.maxWei)} gwei` : `${showGwei(f.minWei)} to ${showGwei(f.maxWei)} gwei (middle ${showGwei(f.medianWei)})`;
      return `${name}: ${f.mints} mint${f.mints === 1 ? '' : 's'} in the first block, ${f.secondsAfterStart}s after it opened, paying ${range}. ${p.opening.mints}${p.opening.sampled ? '+' : ''} in its first ${p.opening.seconds}s, the top paying ${showGwei(p.opening.maxWei)} gwei.`;
    }
    case 'quiet':
      return `${name}: nobody minted in its first ${p.seconds}s, so it was not contested.`;
    case 'too_old':
      return `${name}: opened more than 60 days ago, not read.`;
    case 'not_started':
      return `${name}: not open yet on chain.`;
    default:
      return `${name}: could not be read from the chain right now.`;
  }
}
