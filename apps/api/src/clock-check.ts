/**
 * How far this server's clock is from the two clocks a signed mint races: OpenSea's, which decides
 * when its mint endpoint starts answering, and the chain's, which the contract compares the start time
 * to.
 */
export interface ClockReading {
  source: 'opensea' | 'chain';
  /** Positive: this server is AHEAD of the reference. */
  offsetMs: number;
  /** +/- this much, from the reference's 1s resolution and half the request round trip. */
  uncertaintyMs: number;
}

export interface ClockCheckResult {
  readings: ClockReading[];
  /** True when OpenSea's clock differs by more than the threshold, or this server is behind the latest block by more than it. */
  skewed: boolean;
  thresholdMs: number;
  summary: string;
}

export const CLOCK_SKEW_THRESHOLD_MS = 1_000;

export function readingFromHttpDate(serverDateMs: number, localMidpointMs: number, roundTripMs: number): ClockReading {
  return { source: 'opensea', offsetMs: localMidpointMs - (serverDateMs + 500), uncertaintyMs: 500 + Math.ceil(roundTripMs / 2) };
}

export function readingFromBlock(blockTimestampSec: number, localMidpointMs: number, roundTripMs: number): ClockReading {
  return { source: 'chain', offsetMs: localMidpointMs - (blockTimestampSec * 1000 + 500), uncertaintyMs: 500 + Math.ceil(roundTripMs / 2) };
}

/** `skewed` is set when a reading's central estimate is off by more than the threshold. */
export function evaluateClock(readings: ClockReading[], thresholdMs = CLOCK_SKEW_THRESHOLD_MS): ClockCheckResult {
  const skewed = readings.some((r) => (r.source === 'chain' ? r.offsetMs < -thresholdMs : Math.abs(r.offsetMs) > thresholdMs));
  const parts = readings.map(
    (r) => `${r.source} ${r.offsetMs >= 0 ? '+' : ''}${r.offsetMs}ms (±${r.uncertaintyMs}ms${r.source === 'chain' && r.offsetMs > 0 ? ', latest block may simply be old' : ''})`,
  );
  const summary = readings.length === 0 ? 'no clock reference could be read' : `server clock vs ${parts.join(', ')}`;
  return { readings, skewed, thresholdMs, summary };
}
