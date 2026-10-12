import { withTimeout } from '@stryx/utils';
import { mapWithConcurrency } from './concurrency.js';

/** What the priority-fee "Suggest" button shows. */

export interface BlockStamp {
  number: bigint;
  /** Unix seconds. */
  timestamp: bigint;
  /** Null on a chain without EIP-1559. */
  baseFeePerGas: bigint | null;
}

export interface FeeHistoryReading {
  /** Per block, the requested reward percentiles, in wei. */
  reward: bigint[][];
  gasUsedRatio: number[];
  /** One more entry than blocks: the last is the NEXT block's base fee. */
  baseFeePerGas: bigint[];
}

export interface MintTxRef {
  hash: `0x${string}`;
  blockNumber: bigint;
}

/** The chain reads this needs; the viem adapter is in tip-suggestion-reader.ts. */
export interface TipChainReader {
  feeHistory(blockCount: number, percentiles: number[]): Promise<FeeHistoryReading>;
  latestBlock(): Promise<BlockStamp>;
  block(number: bigint): Promise<BlockStamp>;
  /** Transactions that minted from `contract` in [fromBlock, toBlock], unique, in chain order. */
  mintTxs(contract: `0x${string}`, fromBlock: bigint, toBlock: bigint): Promise<MintTxRef[]>;
  /** The receipt's effectiveGasPrice: base fee + the tip actually paid, per gas. */
  effectiveGasPrice(hash: `0x${string}`): Promise<bigint>;
}

export interface NetworkTips {
  /** Blocks with transactions in them that the figures come from. */
  blocks: number;
  /** Median, over those blocks, of each block's 50th / 90th / 99th percentile tip. Wei strings. */
  typicalWei: string;
  busyWei: string;
  topWei: string;
  /** The next block's base fee, for context. Null on a chain without one. */
  nextBaseFeeWei: string | null;
}

export interface TipStats {
  /** Mint transactions the figures come from. */
  mints: number;
  minWei: string;
  medianWei: string;
  p90Wei: string;
  maxWei: string;
}

export type PhaseOpening =
  | {
      startMs: number;
      status: 'ok';
      /** The first block at or after the start that had any mint in it, and what those paid. */
      firstBlock: TipStats & { number: string; secondsAfterStart: number };
      /** Every mint in the opening window (see OPENING_WINDOW_SECONDS / OPENING_WINDOW_BLOCKS). */
      opening: TipStats & { seconds: number; blocks: number; sampled: boolean };
    }
  /** Started, but nobody minted in the opening window: it was not contested. */
  | { startMs: number; status: 'quiet'; seconds: number; blocks: number }
  | { startMs: number; status: 'not_started' | 'too_old' | 'unavailable' };

export interface TipSuggestion {
  chainId: number;
  network: NetworkTips | null;
  phases: PhaseOpening[];
  fetchedAt: number;
}

/** Blocks of recent history for "the chain right now". */
export const NETWORK_BLOCKS = 20;
export const NETWORK_TTL_MS = 12_000;
/** The opening is the first 30 seconds, or 30 blocks if those come sooner (a 0.4s-block chain). */
export const OPENING_WINDOW_SECONDS = 30;
export const OPENING_WINDOW_BLOCKS = 30;
/** Receipts read per phase at most (first blocks first, so the first block is always whole). */
export const MAX_RECEIPTS = 60;
/** Older phases are skipped: many RPC providers do not serve logs that old, and the crowd has moved on. */
export const MAX_PHASE_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/** At most this many phases per request. */
export const MAX_PHASES = 3;
const READ_TIMEOUT_MS = 10_000;
const PHASE_BUDGET_MS = 25_000;
/** Block reads allowed while searching for the start block (a 40M-block chain needs about 30). */
const SEARCH_READ_BUDGET = 64;
const CACHE_LIMIT = 500;

const sorted = (xs: readonly bigint[]): bigint[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Nearest-rank percentile of an already sorted, non-empty list. */
function pct(sortedXs: readonly bigint[], p: number): bigint {
  const i = Math.min(sortedXs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedXs.length) - 1));
  return sortedXs[i] as bigint;
}

export function tipStats(tips: readonly bigint[]): TipStats {
  const s = sorted(tips);
  return { mints: s.length, minWei: String(s[0]), medianWei: String(pct(s, 50)), p90Wei: String(pct(s, 90)), maxWei: String(s[s.length - 1]) };
}

/** Median of each block's percentiles, over blocks that had transactions (an empty block reports 0). */
export function summarizeFeeHistory(h: FeeHistoryReading): NetworkTips {
  const rows = h.reward.filter((_, i) => (h.gasUsedRatio[i] ?? 0) > 0 && (h.reward[i]?.length ?? 0) >= 3);
  const col = (k: number) => (rows.length === 0 ? 0n : pct(sorted(rows.map((r) => r[k] as bigint)), 50));
  const next = h.baseFeePerGas[h.baseFeePerGas.length - 1];
  return { blocks: rows.length, typicalWei: String(col(0)), busyWei: String(col(1)), topWei: String(col(2)), nextBaseFeeWei: next === undefined || next === 0n ? null : String(next) };
}

/** The tip a transaction actually paid per gas. */
export function paidTip(effectiveGasPrice: bigint, baseFee: bigint | null): bigint {
  const tip = baseFee === null ? effectiveGasPrice : effectiveGasPrice - baseFee;
  return tip < 0n ? 0n : tip;
}

/**
 * The first block whose timestamp is at or after `t` (unix seconds): the first block in which a
 * contract checking `block.timestamp >= startTime` could mint.
 */
export async function firstBlockAtOrAfter(read: (n: bigint) => Promise<BlockStamp>, latest: BlockStamp, t: bigint): Promise<BlockStamp | null> {
  if (latest.timestamp < t) return null;
  let reads = 0;
  const cache = new Map<bigint, BlockStamp>([[latest.number, latest]]);
  const get = async (n: bigint): Promise<BlockStamp> => {
    const hit = cache.get(n);
    if (hit) return hit;
    if (++reads > SEARCH_READ_BUDGET) throw new Error('block search ran past its read budget');
    const b = await read(n);
    cache.set(n, b);
    return b;
  };

  const span = latest.number < 1000n ? latest.number : 1000n;
  let guess = 0n;
  if (span > 0n) {
    const back = await get(latest.number - span);
    const elapsed = latest.timestamp - back.timestamp;
    const behind = elapsed > 0n ? ((latest.timestamp - t) * span) / elapsed : latest.timestamp - t;
    guess = behind >= latest.number ? 0n : latest.number - behind;
  }

  // Bracket it: ts(lo) < t <= ts(hi), widening the step each time the guess was short.
  let lo: bigint;
  let hi: bigint;
  let step = 16n;
  const g = await get(guess);
  if (g.timestamp >= t) {
    hi = guess;
    for (;;) {
      if (hi === 0n) return get(0n); // the chain's first block is already at or after t
      lo = hi > step ? hi - step : 0n;
      if ((await get(lo)).timestamp < t) break;
      hi = lo;
      step *= 2n;
    }
  } else {
    lo = guess;
    for (;;) {
      // latest.timestamp >= t, so this ends by latest at the very last.
      hi = lo + step > latest.number ? latest.number : lo + step;
      if ((await get(hi)).timestamp >= t) break;
      lo = hi;
      step *= 2n;
    }
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await get(mid)).timestamp >= t) hi = mid;
    else lo = mid;
  }
  return get(hi);
}

export class TipSuggestionService {
  private readonly network = new Map<number, { value: NetworkTips; at: number }>();
  private readonly networkInFlight = new Map<number, Promise<NetworkTips>>();
  private readonly phaseCache = new Map<string, { value: PhaseOpening; at: number; final: boolean }>();
  private readonly phaseInFlight = new Map<string, Promise<PhaseOpening>>();

  constructor(
    private readonly readerFor: (chainId: number) => TipChainReader | null,
    private readonly now: () => number = Date.now,
  ) {}

  async suggest(chainId: number, contract: `0x${string}` | null, startsMs: readonly number[]): Promise<TipSuggestion> {
    const reader = this.readerFor(chainId);
    if (!reader) throw new Error(`no chain reader for chainId=${chainId}`);
    const starts = [...new Set(startsMs)].sort((a, b) => b - a).slice(0, MAX_PHASES);
    const [network, phases] = await Promise.all([
      this.networkTips(chainId, reader).catch(() => null),
      contract ? Promise.all(starts.map((s) => this.phaseOpening(chainId, reader, contract, s))) : Promise.resolve([]),
    ]);
    return { chainId, network, phases, fetchedAt: this.now() };
  }

  private async networkTips(chainId: number, reader: TipChainReader): Promise<NetworkTips> {
    const hit = this.network.get(chainId);
    if (hit && this.now() - hit.at < NETWORK_TTL_MS) return hit.value;
    let pending = this.networkInFlight.get(chainId);
    if (!pending) {
      pending = withTimeout(reader.feeHistory(NETWORK_BLOCKS, [50, 90, 99]), READ_TIMEOUT_MS, `fee history (chain ${chainId})`)
        .then((h) => {
          const value = summarizeFeeHistory(h);
          this.network.set(chainId, { value, at: this.now() });
          return value;
        })
        .finally(() => this.networkInFlight.delete(chainId));
      this.networkInFlight.set(chainId, pending);
    }
    return pending;
  }

  private async phaseOpening(chainId: number, reader: TipChainReader, contract: `0x${string}`, startMs: number): Promise<PhaseOpening> {
    const now = this.now();
    if (startMs > now) return { startMs, status: 'not_started' };
    if (now - startMs > MAX_PHASE_AGE_MS) return { startMs, status: 'too_old' };

    const key = `${chainId}:${contract.toLowerCase()}:${startMs}`;
    const hit = this.phaseCache.get(key);
    // A finished opening never changes; one still in progress is re-read after a short while.
    if (hit && (hit.final || now - hit.at < NETWORK_TTL_MS)) return hit.value;

    let pending = this.phaseInFlight.get(key);
    if (!pending) {
      pending = withTimeout(this.readOpening(reader, contract, startMs), PHASE_BUDGET_MS, `phase opening (chain ${chainId})`)
        .then(({ value, final }) => {
          if (this.phaseCache.size >= CACHE_LIMIT) this.phaseCache.delete(this.phaseCache.keys().next().value as string);
          this.phaseCache.set(key, { value, at: this.now(), final });
          return value;
        })
        .catch((): PhaseOpening => ({ startMs, status: 'unavailable' }))
        .finally(() => this.phaseInFlight.delete(key));
      this.phaseInFlight.set(key, pending);
    }
    return pending;
  }

  private async readOpening(reader: TipChainReader, contract: `0x${string}`, startMs: number): Promise<{ value: PhaseOpening; final: boolean }> {
    const bounded = <T>(p: Promise<T>, what: string) => withTimeout(p, READ_TIMEOUT_MS, what);
    // A block can include a mint once block.timestamp (whole seconds) >= the start.
    const t = BigInt(Math.ceil(startMs / 1000));
    const latest = await bounded(reader.latestBlock(), 'latest block');
    const first = await firstBlockAtOrAfter((n) => bounded(reader.block(n), 'block'), latest, t);
    if (!first) return { value: { startMs, status: 'not_started' }, final: false };

    const end = t + BigInt(OPENING_WINDOW_SECONDS);
    const lastByCount = first.number + BigInt(OPENING_WINDOW_BLOCKS - 1);
    // Final once the chain is past the window by either measure: nothing more can land in it.
    const final = latest.timestamp > end || latest.number >= lastByCount;
    const blocks = new Map<bigint, BlockStamp>([[first.number, first], [latest.number, latest]]);
    const stampOf = async (n: bigint) => {
      const hit = blocks.get(n);
      if (hit) return hit;
      const b = await bounded(reader.block(n), 'block');
      blocks.set(n, b);
      return b;
    };
    // The last block inside the window: bisect over at most OPENING_WINDOW_BLOCKS blocks.
    let lo = first.number;
    let hi = lastByCount < latest.number ? lastByCount : latest.number;
    if ((await stampOf(hi)).timestamp > end) {
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        if ((await stampOf(mid)).timestamp <= end) lo = mid;
        else hi = mid;
      }
      hi = lo;
    }
    const toBlock = hi;
    const windowBlocks = Number(toBlock - first.number) + 1;
    const windowSeconds = Number((await stampOf(toBlock)).timestamp - t);

    const inWindow = await bounded(reader.mintTxs(contract, first.number, toBlock), 'mint logs');
    if (inWindow.length === 0) return { value: { startMs, status: 'quiet', seconds: windowSeconds, blocks: windowBlocks }, final };

    const sample = inWindow.slice(0, MAX_RECEIPTS);
    const tips = await mapWithConcurrency(sample, 6, async (ref) => paidTip(await bounded(reader.effectiveGasPrice(ref.hash), 'receipt'), (await stampOf(ref.blockNumber)).baseFeePerGas));
    const firstNumber = (sample[0] as MintTxRef).blockNumber;
    const firstTips = tips.filter((_, i) => (sample[i] as MintTxRef).blockNumber === firstNumber);
    const firstStamp = await stampOf(firstNumber);
    return {
      value: {
        startMs,
        status: 'ok',
        firstBlock: { ...tipStats(firstTips), number: String(firstNumber), secondsAfterStart: Math.max(0, Math.round((Number(firstStamp.timestamp) * 1000 - startMs) / 100) / 10) },
        opening: { ...tipStats(tips), seconds: windowSeconds, blocks: windowBlocks, sampled: inWindow.length > sample.length },
      },
      final,
    };
  }
}
