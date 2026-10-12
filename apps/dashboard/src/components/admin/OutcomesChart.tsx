import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { computeTooltipPosition } from '@stryx/chain-ui';
import { axisLabel, barLayout, bucketRangeLabel, failureSplitText, niceTicks, type ChartBucket, type ChartUnit } from '../../lib/outcome-chart';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const HEIGHT = 240;
const MARGIN = { left: 36, right: 8, top: 8, bottom: 24 };

/** The width of an element, following it as it resizes. */
function useElementWidth(ref: React.RefObject<HTMLElement>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const UNKNOWN = 'Before Stryx kept records';

/** One line of what a bucket holds, for the screen-reader announcement and the hidden table. */
function describeBucket(unit: ChartUnit, bucket: ChartBucket, opts: { locale?: string; timeZone?: string }): string {
  const when = bucketRangeLabel(unit, bucket, opts);
  if (!bucket.recorded) return `${when}: ${UNKNOWN.toLowerCase()}`;
  const base = `${when}: ${bucket.confirmed} confirmed, ${bucket.failed} failed`;
  return bucket.failed > 0 ? `${base} (${failureSplitText(bucket)})` : base;
}

function ChartTooltip({ id, anchor, contentKey, children }: { id: string; anchor: Rect; contentKey: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = el.getBoundingClientRect();
    const p = computeTooltipPosition({
      anchor,
      tip: { width: size.width, height: size.height },
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    });
    setPos({ left: Math.round(p.left), top: Math.round(p.top) });
  }, [anchor, contentKey]);
  return createPortal(
    <div ref={ref} id={id} role="tooltip" className="chart-tip" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

/**
 * Mints over time, platform-wide: one stacked bar per hour or UTC day, confirmed at the bottom and
 * failed on top, with a table of the same numbers for screen readers.
 */
export function OutcomesChart({ buckets, unit, locale, timeZone }: { buckets: readonly ChartBucket[]; unit: ChartUnit; locale?: string; timeZone?: string }) {
  const summary = { buckets, unrecordedBuckets: buckets.filter((b) => !b.recorded).length };
  const uid = useId().replace(/:/g, '');
  const hatchId = `hatch-${uid}`;
  const tipId = `chart-tip-${uid}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const width = useElementWidth(wrapRef, 720);
  const opts = useMemo(() => ({ ...(locale ? { locale } : {}), ...(timeZone ? { timeZone } : {}) }), [locale, timeZone]);

  const plot = { left: MARGIN.left, top: MARGIN.top, width: Math.max(120, width - MARGIN.left - MARGIN.right), height: HEIGHT - MARGIN.top - MARGIN.bottom };
  const { yMax, ticks } = niceTicks(Math.max(0, ...summary.buckets.map((b) => b.confirmed + b.failed)));
  const geometry = barLayout({ buckets: summary.buckets, yMax, plot });

  const [active, setActive] = useState<{ index: number; rect: Rect } | null>(null);
  const clear = () => setActive(null);

  const show = (index: number) => {
    const slot = svgRef.current?.querySelector(`[data-slot="${index}"]`);
    if (!slot) return;
    const r = slot.getBoundingClientRect();
    setActive({ index, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
  };

  // Closing: a press outside the chart, Escape, or scrolling (the tooltip is fixed, so it would drift off its bar).
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) clear();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', clear, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', clear, { capture: true });
    };
  }, [active]);

  const last = summary.buckets.length - 1;
  const onKeyDown = (e: KeyboardEvent) => {
    const from = active?.index;
    const next = e.key === 'ArrowRight' ? (from === undefined ? 0 : Math.min(last, from + 1))
      : e.key === 'ArrowLeft' ? (from === undefined ? last : Math.max(0, from - 1))
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    show(next);
  };

  const activeBucket = active ? summary.buckets[active.index] : undefined;

  return (
    <div className="chart" ref={wrapRef}>
      <div
        className="chart__plot"
        role="group"
        tabIndex={0}
        aria-label="Mints over time. Use the left and right arrow keys to read each bar. The same numbers are in the table below."
        aria-describedby={active ? tipId : undefined}
        onKeyDown={onKeyDown}
        onBlur={clear}
      >
        <svg ref={svgRef} className="chart__svg" viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true">
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line className="chart-hatch-line" x1="0" y1="0" x2="0" y2="6" />
            </pattern>
          </defs>

          {ticks.map((t) => {
            const y = plot.top + plot.height - (t / yMax) * plot.height;
            return (
              <g key={t}>
                <line className="chart-grid" x1={plot.left} x2={plot.left + plot.width} y1={y} y2={y} />
                <text className="chart-axis-text" x={plot.left - 6} y={y + 4} textAnchor="end">
                  {t}
                </text>
              </g>
            );
          })}

          {summary.buckets.map((bucket, i) => {
            const g = geometry[i]!;
            const label = axisLabel(unit, i, summary.buckets.length, bucket, opts);
            return (
              <g key={bucket.start}>
                <rect className={`chart-slot${bucket.recorded ? '' : ' chart-slot--unrecorded'}`} x={g.x} y={plot.top} width={g.width} height={plot.height} rx={3} />
                {bucket.recorded && g.confirmedHeight > 0 && <rect className="chart-bar--confirmed" x={g.x} y={g.confirmedY} width={g.width} height={g.confirmedHeight} />}
                {bucket.recorded && g.failedHeight > 0 && (
                  <>
                    <rect className="chart-bar--failed" x={g.x} y={g.failedY} width={g.width} height={g.failedHeight} />
                    <rect fill={`url(#${hatchId})`} x={g.x} y={g.failedY} width={g.width} height={g.failedHeight} />
                  </>
                )}
                {label && (
                  <text className="chart-axis-text" x={g.slotX + g.slotWidth / 2} y={plot.top + plot.height + 16} textAnchor="middle">
                    {label}
                  </text>
                )}
                <rect
                  className="chart-hit"
                  data-slot={i}
                  x={g.slotX}
                  y={plot.top}
                  width={g.slotWidth}
                  height={plot.height}
                  onPointerEnter={(e) => e.pointerType !== 'touch' && show(i)}
                  onPointerLeave={(e) => e.pointerType !== 'touch' && clear()}
                  onPointerDown={(e) => e.pointerType === 'touch' && (active?.index === i ? clear() : show(i))}
                />
              </g>
            );
          })}

          {active && geometry[active.index] && <rect className="chart-active" x={geometry[active.index]!.x} y={plot.top} width={geometry[active.index]!.width} height={plot.height} rx={3} />}
        </svg>
      </div>

      <ul className="chart-legend">
        <li>
          <span className="chart-swatch chart-swatch--confirmed" aria-hidden="true" />
          <span aria-hidden="true">✓</span> Confirmed
        </li>
        <li>
          <span className="chart-swatch chart-swatch--failed" aria-hidden="true" />
          <span aria-hidden="true">✕</span> Failed
        </li>
        {summary.unrecordedBuckets > 0 && (
          <li>
            <span className="chart-swatch chart-swatch--unrecorded" aria-hidden="true" /> {UNKNOWN}
          </li>
        )}
      </ul>

      {/* Spoken as the arrow keys move. */}
      <span className="sr-only" aria-live="polite">
        {activeBucket ? describeBucket(unit, activeBucket, opts) : ''}
      </span>

      {/* The wrapper is what is hidden, not the table: a table cannot shrink below its content. */}
      <div className="sr-only">
        <table>
          <caption>{`Mints by ${unit}`}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Confirmed</th>
              <th scope="col">Failed</th>
              <th scope="col">Failed on chain</th>
              <th scope="col">Refused before sending</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {summary.buckets.map((b) => (
              <tr key={b.start}>
                <th scope="row">{bucketRangeLabel(unit, b, opts)}</th>
                <td>{b.recorded ? b.confirmed : ''}</td>
                <td>{b.recorded ? b.failed : ''}</td>
                <td>{b.recorded ? b.reverted : ''}</td>
                <td>{b.recorded ? b.blocked : ''}</td>
                <td>{!b.recorded ? UNKNOWN : b.partial ? 'Records began during this period' : b.pending > 0 ? `${b.pending} still pending` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {active && activeBucket && (
        <ChartTooltip id={tipId} anchor={active.rect} contentKey={Date.parse(activeBucket.start)}>
          <strong className="chart-tip__title">{bucketRangeLabel(unit, activeBucket, opts)}</strong>
          {!activeBucket.recorded ? (
            <div className="chart-tip__note">{UNKNOWN}</div>
          ) : (
            <>
              <dl style={{ margin: 0 }}>
                <div className="chart-tip__row">
                  <dt className="chart-tip__ok">Confirmed</dt>
                  <dd>{activeBucket.confirmed}</dd>
                </div>
                <div className="chart-tip__row">
                  <dt className="chart-tip__bad">Failed</dt>
                  <dd>{activeBucket.failed}</dd>
                </div>
              </dl>
              {activeBucket.failed > 0 && <div className="chart-tip__note">{failureSplitText(activeBucket)}</div>}
              {activeBucket.pending > 0 && <div className="chart-tip__note">{activeBucket.pending} still pending</div>}
              {activeBucket.partial && <div className="chart-tip__note">Records began during this period, so this may be low.</div>}
            </>
          )}
        </ChartTooltip>
      )}
    </div>
  );
}
