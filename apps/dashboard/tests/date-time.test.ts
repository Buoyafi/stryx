import { afterEach, describe, expect, it } from 'vitest';
import { addDays, addMonths, compareDay, daysInMonth, formatDisplay, formatLocal, fromMs, monthGrid, monthLabel, normalize, parseLocal, timeZoneLabel, toDate, weekdayNames } from '../src/lib/date-time';

const originalTz = process.env.TZ;
const useZone = (tz: string) => {
  process.env.TZ = tz;
};
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('parseLocal / formatLocal', () => {
  it('round-trips the value a datetime-local input uses', () => {
    expect(parseLocal('2026-10-07T15:05')).toEqual({ year: 2026, month: 10, day: 7, hour: 15, minute: 5 });
    expect(formatLocal({ year: 2026, month: 10, day: 7, hour: 15, minute: 5 })).toBe('2026-10-07T15:05');
    expect(formatLocal(parseLocal('2026-01-09T00:00')!)).toBe('2026-01-09T00:00');
  });

  it('accepts a value with seconds and drops them', () => {
    expect(parseLocal('2026-10-07T15:05:30')).toEqual({ year: 2026, month: 10, day: 7, hour: 15, minute: 5 });
  });

  it('rejects anything that is not a real day or time', () => {
    for (const bad of ['', 'tomorrow', '2026-10-07', '2026-13-01T10:00', '2026-02-30T10:00', '2026-10-07T24:00', '2026-10-07T10:60', '2026-10-7T10:00']) {
      expect(parseLocal(bad)).toBeNull();
    }
    expect(parseLocal('2024-02-29T10:00')).not.toBeNull(); // leap day
    expect(parseLocal('2026-02-29T10:00')).toBeNull();
  });
});

describe('the value means the same instant the callers get from new Date(value)', () => {
  it('in a zone ahead of UTC and in one behind it', () => {
    for (const tz of ['Africa/Lagos', 'America/New_York', 'Asia/Kolkata', 'UTC']) {
      useZone(tz);
      const value = '2026-10-07T15:00';
      expect(toDate(parseLocal(value)!).getTime()).toBe(new Date(value).getTime());
    }
  });

  it('Lagos 15:00 on 7 October 2026 is 14:00 UTC', () => {
    useZone('Africa/Lagos');
    expect(toDate(parseLocal('2026-10-07T15:00')!).toISOString()).toBe('2026-10-07T14:00:00.000Z');
  });
});

describe('daylight saving', () => {
  it('a time in the hour that is skipped is shown as the time the clock will really read', () => {
    useZone('Europe/London'); // clocks go from 01:00 to 02:00 on 29 March 2026
    const asked = parseLocal('2026-03-29T01:30')!;
    expect(formatLocal(normalize(asked))).toBe('2026-03-29T02:30');
    expect(toDate(asked).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('an ordinary time is left alone, on both sides of the change', () => {
    useZone('Europe/London');
    for (const v of ['2026-03-28T01:30', '2026-03-29T03:00', '2026-10-25T12:00']) expect(formatLocal(normalize(parseLocal(v)!))).toBe(v);
  });

  it('moving a day across the change keeps the wall-clock day, not 24 hours', () => {
    useZone('Europe/London');
    expect(addDays({ year: 2026, month: 3, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 29 });
    expect(addDays({ year: 2026, month: 3, day: 29 }, 1)).toEqual({ year: 2026, month: 3, day: 30 });
    expect(addDays({ year: 2026, month: 10, day: 25 }, 1)).toEqual({ year: 2026, month: 10, day: 26 });
  });

  it('a zone with no daylight saving never changes a time', () => {
    useZone('Africa/Lagos');
    expect(formatLocal(normalize(parseLocal('2026-03-29T01:30')!))).toBe('2026-03-29T01:30');
  });
});

describe('fromMs', () => {
  it('rounds up to the whole minute, so "in 5 minutes" is never short', () => {
    useZone('UTC');
    expect(fromMs(Date.UTC(2026, 9, 7, 15, 0, 0))).toBe('2026-10-07T15:00');
    expect(fromMs(Date.UTC(2026, 9, 7, 15, 0, 1))).toBe('2026-10-07T15:01');
    expect(fromMs(Date.UTC(2026, 9, 7, 23, 59, 30))).toBe('2026-10-08T00:00');
  });
});

describe('monthGrid', () => {
  it('is always six weeks, Monday first', () => {
    const grid = monthGrid(2026, 10); // 1 October 2026 is a Thursday
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ year: 2026, month: 9, day: 28, inMonth: false });
    expect(grid[3]).toEqual({ year: 2026, month: 10, day: 1, inMonth: true });
    expect(grid.filter((c) => c.inMonth)).toHaveLength(31);
    expect(grid[41]).toEqual({ year: 2026, month: 11, day: 8, inMonth: false });
  });

  it('a month that starts on a Monday starts in the first cell; February in a leap year has 29 days', () => {
    expect(monthGrid(2026, 6)[0]).toEqual({ year: 2026, month: 6, day: 1, inMonth: true });
    expect(monthGrid(2024, 2).filter((c) => c.inMonth)).toHaveLength(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('crosses the year end in both directions', () => {
    expect(monthGrid(2027, 1)[0]).toEqual({ year: 2026, month: 12, day: 28, inMonth: false });
    expect(monthGrid(2026, 12)[41]!.year).toBe(2027);
  });
});

describe('addMonths / compareDay', () => {
  it('keeps the day where it exists and clamps where it does not', () => {
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(addMonths({ year: 2026, month: 12, day: 15 }, 1)).toEqual({ year: 2027, month: 1, day: 15 });
    expect(addMonths({ year: 2026, month: 1, day: 15 }, -1)).toEqual({ year: 2025, month: 12, day: 15 });
  });

  it('orders days', () => {
    expect(compareDay({ year: 2026, month: 10, day: 7 }, { year: 2026, month: 10, day: 8 })).toBeLessThan(0);
    expect(compareDay({ year: 2027, month: 1, day: 1 }, { year: 2026, month: 12, day: 31 })).toBeGreaterThan(0);
    expect(compareDay({ year: 2026, month: 10, day: 7 }, { year: 2026, month: 10, day: 7 })).toBe(0);
  });
});

describe('labels', () => {
  it('shows the day, the date and a 24-hour time', () => {
    useZone('UTC');
    expect(formatDisplay(parseLocal('2026-10-07T15:05')!, 'en-GB')).toBe('Wed, 7 Oct 2026, 15:05');
    expect(formatDisplay(parseLocal('2026-10-07T00:00')!, 'en-GB')).toBe('Wed, 7 Oct 2026, 00:00');
    expect(monthLabel(2026, 10, 'en-GB')).toBe('October 2026');
  });

  it('names the weekdays Monday first', () => {
    expect(weekdayNames('en-GB').map((d) => d.short)).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    expect(weekdayNames('en-GB')[0]!.long).toBe('Monday');
  });

  it('names the zone with the offset in force at that moment', () => {
    useZone('Africa/Lagos');
    expect(timeZoneLabel(new Date('2026-10-07T12:00:00Z'))).toBe('GMT+1, Africa/Lagos');
    useZone('Europe/London');
    expect(timeZoneLabel(new Date('2026-07-01T12:00:00Z'))).toMatch(/^GMT\+1/);
    expect(timeZoneLabel(new Date('2026-12-01T12:00:00Z'))).toMatch(/^GMT\+0/);
    useZone('Asia/Kolkata');
    expect(timeZoneLabel(new Date('2026-10-07T12:00:00Z'))).toMatch(/^GMT\+5:30/);
    useZone('America/New_York');
    expect(timeZoneLabel(new Date('2026-12-01T12:00:00Z'))).toMatch(/^GMT-5/);
  });
});
