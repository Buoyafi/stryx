/** Pure helpers for the mint outcomes chart (components/admin/OutcomesChart.tsx): y-axis ticks, bar geometry and labels. */

export interface ChartBucket {
  start: string;
  end: string;
  confirmed: number;
  reverted: number;
  blocked: number;
  failed: number;
  pending: number;
  recorded: boolean;
  partial: boolean;
}

export type ChartUnit = 'hour' | 'day';

/** Whole-number ticks from 0 to a rounded-up top, at most four intervals, for the y axis. */
export function niceTicks(max: number): { yMax: number; ticks: number[] } {
  if (max <= 0) return { yMax: 4, ticks: [0, 2, 4] };
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000];
  const step = steps.find((s) => Math.ceil(max / s) <= 4) ?? Math.ceil(max / 4);
  const yMax = step * Math.ceil(max / step);
  return { yMax, ticks: Array.from({ length: yMax / step + 1 }, (_, i) => i * step) };
}

const fmt = (opts: { locale?: string | undefined; timeZone?: string | undefined }, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(opts.locale, { ...(opts.timeZone ? { timeZone: opts.timeZone } : {}), ...o });

/**
 * Hours are shown in the viewer's own time (an hour is the same hour everywhere that is a whole number
 * of hours from UTC); days are UTC days, so they are labelled in UTC and two operators see the same
 * days.
 */
const zoneFor = (unit: ChartUnit, timeZone?: string) => (unit === 'day' ? 'UTC' : timeZone);

/** The full range of a bucket, for the tooltip and the hidden table. "to", never a dash. */
export function bucketRangeLabel(unit: ChartUnit, b: Pick<ChartBucket, 'start' | 'end'>, opts: { locale?: string; timeZone?: string } = {}): string {
  const o = { locale: opts.locale, timeZone: zoneFor(unit, opts.timeZone) };
  const start = Date.parse(b.start);
  if (unit === 'hour') {
    const hm = fmt(o, { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${fmt(o, { month: 'short', day: 'numeric' }).format(start)}, ${hm.format(start)} to ${hm.format(Date.parse(b.end))}`;
  }
  return `${fmt(o, { weekday: 'short', month: 'short', day: 'numeric' }).format(start)} (UTC)`;
}

/** A short x-axis label, or null to skip this bucket so the axis stays readable. */
export function axisLabel(unit: ChartUnit, index: number, count: number, b: Pick<ChartBucket, 'start'>, opts: { locale?: string; timeZone?: string } = {}): string | null {
  const o = { locale: opts.locale, timeZone: zoneFor(unit, opts.timeZone) };
  const start = Date.parse(b.start);
  if (unit === 'hour') return index % 4 === 0 || index === count - 1 ? fmt(o, { hour: '2-digit', hour12: false }).format(start) : null;
  if (count <= 7) return fmt(o, { weekday: 'short' }).format(start);
  return index % 5 === 0 || index === count - 1 ? fmt(o, { day: 'numeric' }).format(start) : null;
}

/** The two kinds of failure in words (one red stack in the chart). */
export function failureSplitText(b: Pick<ChartBucket, 'reverted' | 'blocked'>): string {
  return `${b.reverted} failed on chain · ${b.blocked} refused before sending`;
}

export interface BarGeometry {
  x: number;
  width: number;
  /** The whole slot: where hover and taps land. */
  slotX: number;
  slotWidth: number;
  confirmedY: number;
  confirmedHeight: number;
  failedY: number;
  failedHeight: number;
}

/** Where each bar goes. Confirmed at the bottom, failed stacked on top; an empty bucket keeps its slot. */
export function barLayout(input: { buckets: readonly Pick<ChartBucket, 'confirmed' | 'failed'>[]; yMax: number; plot: { left: number; top: number; width: number; height: number }; gap?: number }): BarGeometry[] {
  const { buckets, yMax, plot } = input;
  const slot = plot.width / Math.max(1, buckets.length);
  const gap = Math.min(input.gap ?? 4, slot / 3);
  const unit = plot.height / yMax;
  return buckets.map((b, i) => {
    const slotX = plot.left + i * slot;
    const confirmedHeight = b.confirmed * unit;
    const failedHeight = b.failed * unit;
    const bottom = plot.top + plot.height;
    return {
      slotX,
      slotWidth: slot,
      x: slotX + gap / 2,
      width: Math.max(1, slot - gap),
      confirmedHeight,
      confirmedY: bottom - confirmedHeight,
      failedHeight,
      // A 2px surface gap between the two stacked segments, when both are there.
      failedY: bottom - confirmedHeight - failedHeight - (confirmedHeight > 0 && failedHeight > 0 ? 2 : 0),
    };
  });
}
