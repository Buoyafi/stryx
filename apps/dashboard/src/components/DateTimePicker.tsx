import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dropdown } from './Dropdown';
import {
  addDays,
  addMonths,
  compareDay,
  dayLabel,
  formatDisplay,
  formatLocal,
  fromMs,
  monthGrid,
  monthLabel,
  normalize,
  parseLocal,
  partsOf,
  sameDay,
  timeZoneLabel,
  toDate,
  weekdayNames,
  type LocalParts,
} from '../lib/date-time';

type Day = { year: number; month: number; day: number };

const HOURS = Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: String(i).padStart(2, '0') }));
const MINUTES = Array.from({ length: 60 }, (_, i) => ({ value: String(i), label: String(i).padStart(2, '0') }));
const QUICK = [
  { label: 'In 5 min', ms: 5 * 60_000 },
  { label: 'In 15 min', ms: 15 * 60_000 },
  { label: 'In 1 hour', ms: 60 * 60_000 },
];
/** Below this width the panel is a sheet across the bottom of the screen. */
const SHEET_BELOW_PX = 520;
const PANEL_WIDTH = 316;
const GAP = 6;
const EDGE = 8;

/**
 * A date and time field: a button showing the choice, and a calendar panel with a month grid, hour and
 * minute, and a few shortcuts.
 */
export function DateTimePicker({
  value,
  onChange,
  min,
  placeholder = 'Pick a date and time',
  allowClear = true,
  id,
  'aria-label': ariaLabel,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The earliest moment worth choosing, read when needed (pass `Date.now` for "not in the past"). */
  min?: () => number;
  placeholder?: string;
  allowClear?: boolean;
  id?: string;
  'aria-label'?: string;
  style?: React.CSSProperties;
}) {
  const selected = useMemo(() => parseLocal(value), [value]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ year: number; month: number }>(() => ({ year: 2000, month: 1 }));
  const [focusDay, setFocusDay] = useState<Day>({ year: 2000, month: 1, day: 1 });
  const [place, setPlace] = useState<{ sheet: boolean; top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  const titleId = useId();

  const today = partsOf(new Date());
  const minDay: Day | null = min ? partsOf(new Date(min())) : null;
  const tooEarly = (d: Day) => minDay !== null && compareDay(d, minDay) < 0;

  const position = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw < SHEET_BELOW_PX) {
      setPlace({ sheet: true, top: 0, left: 0 });
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const height = panelRef.current?.offsetHeight ?? 420;
    const left = Math.max(EDGE, Math.min(rect.left, vw - PANEL_WIDTH - EDGE));
    const below = rect.bottom + GAP;
    const above = rect.top - GAP - height;
    const top = below + height <= vh - EDGE ? below : above >= EDGE ? above : Math.max(EDGE, vh - height - EDGE);
    setPlace({ sheet: false, top, left });
  }, []);

  function openPanel() {
    const start: Day = selected ?? (minDay && compareDay(today, minDay) < 0 ? minDay : today);
    setView({ year: start.year, month: start.month });
    setFocusDay({ year: start.year, month: start.month, day: start.day });
    moveFocus.current = true;
    setOpen(true);
  }

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Placed before paint, again once its real height is known, and kept in place while open.
  useLayoutEffect(() => {
    if (!open) return;
    position();
    const again = () => position();
    window.addEventListener('resize', again);
    window.addEventListener('scroll', again, true);
    return () => {
      window.removeEventListener('resize', again);
      window.removeEventListener('scroll', again, true);
    };
  }, [open, position, view.year, view.month]);

  // A press anywhere outside the field and the panel closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open, close]);

  // Escape closes this panel only: it must not also reach a dialog underneath.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // An open hour or minute list takes this Escape for itself.
      if ((e.target as HTMLElement | null)?.getAttribute?.('aria-expanded') === 'true') return;
      e.stopPropagation();
      close(true);
    };
    panel.addEventListener('keydown', onKey);
    return () => panel.removeEventListener('keydown', onKey);
  }, [open, close, place]);

  // Focus follows the day the keys moved to (and lands in the grid when the panel opens).
  useEffect(() => {
    if (!open || !place || !moveFocus.current) return;
    moveFocus.current = false;
    panelRef.current?.querySelector<HTMLElement>('[data-focus-day="true"]')?.focus();
  }, [open, place, focusDay]);

  function emit(next: LocalParts) {
    onChange(formatLocal(normalize(next)));
  }

  /** A day keeps the time already chosen; with none yet, it starts five minutes from now. */
  function chooseDay(d: Day) {
    if (tooEarly(d)) return;
    const time = selected ?? partsOf(new Date(Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000));
    emit({ ...d, hour: time.hour, minute: time.minute });
    setFocusDay(d);
  }

  function chooseTime(patch: { hour?: number; minute?: number }) {
    const base = selected ?? { ...focusDay, hour: 0, minute: 0 };
    emit({ ...base, ...patch });
  }

  function quick(ms: number) {
    const next = fromMs(Date.now() + ms);
    onChange(next);
    const p = parseLocal(next)!;
    setView({ year: p.year, month: p.month });
    setFocusDay({ year: p.year, month: p.month, day: p.day });
  }

  function goTo(d: Day) {
    const target = tooEarly(d) && minDay ? minDay : d;
    setFocusDay(target);
    setView({ year: target.year, month: target.month });
    moveFocus.current = true;
  }

  function onGridKeyDown(e: React.KeyboardEvent) {
    const weekday = (new Date(focusDay.year, focusDay.month - 1, focusDay.day).getDay() + 6) % 7;
    const moves: Record<string, () => Day> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      Home: () => addDays(focusDay, -weekday),
      End: () => addDays(focusDay, 6 - weekday),
      PageUp: () => addMonths(focusDay, -1),
      PageDown: () => addMonths(focusDay, 1),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    goTo(move());
  }

  /** Tab stays inside the panel: it sits at the end of the page, so leaving it would leave the page. */
  function onPanelKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"])') ?? [])];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const days = open ? monthGrid(view.year, view.month) : [];
  const names = open ? weekdayNames() : [];
  const passed = selected !== null && min !== undefined && toDate(selected).getTime() < min();

  const panel = open && (
    <>
      {place?.sheet && <div className="dtp__backdrop" />}
      <div
        ref={panelRef}
        className={`dtp__panel${place?.sheet ? ' dtp__panel--sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={place?.sheet ? undefined : { top: place?.top ?? 0, left: place?.left ?? 0, width: PANEL_WIDTH, visibility: place ? 'visible' : 'hidden' }}
        onKeyDown={onPanelKeyDown}
      >
        <div className="dtp__head">
          <button type="button" className="dtp__nav" aria-label="Previous month" onClick={() => setView((v) => addMonths({ ...v, day: 1 }, -1))}>
            ‹
          </button>
          <div id={titleId} className="dtp__title" aria-live="polite">
            {monthLabel(view.year, view.month)}
          </div>
          <button type="button" className="dtp__nav" aria-label="Next month" onClick={() => setView((v) => addMonths({ ...v, day: 1 }, 1))}>
            ›
          </button>
        </div>

        <div className="dtp__grid" role="grid" aria-labelledby={titleId} onKeyDown={onGridKeyDown}>
          <div className="dtp__row" role="row">
            {names.map((n) => (
              <span key={n.long} className="dtp__weekday" role="columnheader" aria-label={n.long}>
                {n.short}
              </span>
            ))}
          </div>
          {Array.from({ length: 6 }, (_, week) => (
            <div key={week} className="dtp__row" role="row">
              {days.slice(week * 7, week * 7 + 7).map((d) => {
                const isSelected = selected !== null && sameDay(d, selected);
                const isFocus = sameDay(d, focusDay);
                const disabled = tooEarly(d);
                return (
                  <button
                    key={`${d.year}-${d.month}-${d.day}`}
                    type="button"
                    role="gridcell"
                    className={`dtp__day${d.inMonth ? '' : ' is-outside'}${isSelected ? ' is-selected' : ''}${sameDay(d, today) ? ' is-today' : ''}`}
                    aria-selected={isSelected}
                    aria-disabled={disabled || undefined}
                    aria-current={sameDay(d, today) ? 'date' : undefined}
                    aria-label={dayLabel(d)}
                    tabIndex={isFocus ? 0 : -1}
                    data-focus-day={isFocus ? 'true' : undefined}
                    onClick={() => chooseDay(d)}
                  >
                    {d.day}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="dtp__time">
          <span className="dtp__time-label">Time</span>
          <Dropdown aria-label="Hour" options={HOURS} value={selected ? String(selected.hour) : ''} placeholder="hh" onChange={(v) => chooseTime({ hour: Number(v) })} style={{ width: 76 }} />
          <span aria-hidden="true">:</span>
          <Dropdown aria-label="Minute" options={MINUTES} value={selected ? String(selected.minute) : ''} placeholder="mm" onChange={(v) => chooseTime({ minute: Number(v) })} style={{ width: 76 }} />
        </div>

        <div className="dtp__quick">
          {QUICK.map((q) => (
            <button key={q.label} type="button" className="dtp__chip" onClick={() => quick(q.ms)}>
              {q.label}
            </button>
          ))}
        </div>

        {passed && (
          <p className="dtp__warn" role="status">
            That time has already passed.
          </p>
        )}

        <div className="dtp__foot">
          <span className="dtp__zone">Your time: {timeZoneLabel(selected ? toDate(selected) : new Date())}</span>
          <span className="dtp__foot-actions">
            {allowClear && value !== '' && (
              <button type="button" className="dtp__text" onClick={() => onChange('')}>
                Clear
              </button>
            )}
            <button type="button" className="primary dtp__done" onClick={() => close(true)}>
              Done
            </button>
          </span>
        </div>
      </div>
    </>
  );

  return (
    <span className="dtp" style={style}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className="dtp__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel ? `${ariaLabel}: ${selected ? formatDisplay(selected) : 'not set'}` : undefined}
        onClick={() => (open ? close(false) : openPanel())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openPanel();
          }
        }}
      >
        <svg className="dtp__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        </svg>
        <span className={selected ? 'dtp__value' : 'dtp__value is-empty'}>{selected ? formatDisplay(selected) : placeholder}</span>
      </button>
      {panel && createPortal(panel, document.body)}
    </span>
  );
}
