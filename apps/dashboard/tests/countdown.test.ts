import { describe, expect, it } from 'vitest';
import { formatDuration, countdownStatus } from '../src/lib/countdown';

describe('formatDuration', () => {
  it('shows seconds alone under a minute', () => {
    expect(formatDuration(39_000)).toBe('39s');
  });

  it('shows minutes and seconds under an hour', () => {
    expect(formatDuration(24 * 60_000 + 57_000)).toBe('24m 57s');
  });

  it('shows hours, minutes and seconds under a day', () => {
    expect(formatDuration(2 * 3_600_000 + 44 * 60_000 + 39_000)).toBe('2h 44m 39s');
  });

  it('shows days, hours and minutes at a day or beyond (drops seconds)', () => {
    expect(formatDuration(26 * 3_600_000 + 5 * 60_000)).toBe('1d 2h 5m');
  });

  it('floors a negative or sub-second duration to "0s" rather than a negative number', () => {
    expect(formatDuration(-500)).toBe('0s');
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('countdownStatus', () => {
  const NOW = 1_700_000_000_000;

  it('returns null when neither a start nor an end is known', () => {
    expect(countdownStatus(NOW, null, null)).toBeNull();
  });

  it('"starts in" when now is before the start time', () => {
    const status = countdownStatus(NOW, NOW + 60_000, NOW + 120_000);
    expect(status).toEqual({ phase: 'before', label: 'starts in 1m 0s' });
  });

  it('"ends in" once live (now is between start and end)', () => {
    const status = countdownStatus(NOW, NOW - 60_000, NOW + 90_000);
    expect(status).toEqual({ phase: 'live', label: 'ends in 1m 30s' });
  });

  it('"ended" once past the end time', () => {
    const status = countdownStatus(NOW, NOW - 120_000, NOW - 60_000);
    expect(status).toEqual({ phase: 'ended', label: 'ended' });
  });

  it('treats "started, no known end" as live with a plain "live" label, not a countdown to nothing', () => {
    const status = countdownStatus(NOW, NOW - 60_000, null);
    expect(status).toEqual({ phase: 'live', label: 'live' });
  });

  it('treats exactly-at-end as still live, not yet ended (boundary inclusive)', () => {
    const status = countdownStatus(NOW, NOW - 60_000, NOW);
    expect(status?.phase).toBe('live');
  });
});
