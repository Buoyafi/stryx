/** Formats a non-negative duration as its largest 1-3 non-zero units: "2h 44m 39s", "24m 57s", "39s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export type CountdownPhase = 'before' | 'live' | 'ended';

export interface CountdownStatus {
  phase: CountdownPhase;
  label: string;
}

/** Pure: no timers, no React. */
export function countdownStatus(nowMs: number, startMs: number | null, endMs: number | null): CountdownStatus | null {
  if (startMs === null && endMs === null) return null;
  if (startMs !== null && nowMs < startMs) {
    return { phase: 'before', label: `starts in ${formatDuration(startMs - nowMs)}` };
  }
  if (endMs !== null && nowMs <= endMs) {
    return { phase: 'live', label: `ends in ${formatDuration(endMs - nowMs)}` };
  }
  if (endMs !== null) return { phase: 'ended', label: 'ended' };
  return { phase: 'live', label: 'live' }; // started, and no known end to count down to
}
