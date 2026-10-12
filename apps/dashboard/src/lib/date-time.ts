/** Date and time for DateTimePicker. */

export interface LocalParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Building an Intl formatter is slow and a calendar asks for the same few over and over: one each. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  // The time-zone offset is part of the key: if the computer's zone changes while the page is open,
  // labels follow it.
  const key = `${locale ?? ''}|${new Date().getTimezoneOffset()}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, f);
  }
  return f;
}

export function formatLocal(p: LocalParts): string {
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** The parts of a "YYYY-MM-DDTHH:mm" value, or null when it is not one (or names a day that does not exist). */
export function parseLocal(value: string): LocalParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function partsOf(date: Date): LocalParts {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() };
}

/** The instant these wall-clock parts name in this browser's time zone. */
export function toDate(p: LocalParts): Date {
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
}

/** The parts as the clock will really read at that instant. */
export function normalize(p: LocalParts): LocalParts {
  return partsOf(toDate(p));
}

/** A value from an instant, rounded UP to the whole minute so "in 5 minutes" is never 4:59 away. */
export function fromMs(ms: number): string {
  return formatLocal(partsOf(new Date(Math.ceil(ms / 60_000) * 60_000)));
}

export interface DayCell {
  year: number;
  month: number;
  day: number;
  /** False for the days of the previous and next month that fill out the first and last week. */
  inMonth: boolean;
}

/** Six weeks, Monday first, covering the month: always 42 cells, so the panel never changes height. */
export function monthGrid(year: number, month: number): DayCell[] {
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7; // days of the previous month shown before the 1st
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(year, month - 1, 1 - lead + i);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), inMonth: d.getMonth() === month - 1 };
  });
}

/** Moves a calendar day by whole days, through month and year ends. */
export function addDays(p: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(p.year, p.month - 1, p.day + days);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/** Moves by whole months, keeping the day where it exists (31 Jan + 1 month is 28 or 29 Feb). */
export function addMonths(p: { year: number; month: number; day: number }, months: number): { year: number; month: number; day: number } {
  const target = new Date(p.year, p.month - 1 + months, 1);
  const year = target.getFullYear();
  const month = target.getMonth() + 1;
  return { year, month, day: Math.min(p.day, daysInMonth(year, month)) };
}

export const sameDay = (a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day;

/** Negative when a's day is before b's. Time of day is ignored. */
export const compareDay = (a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): number =>
  a.year - b.year || a.month - b.month || a.day - b.day;

/** "Wed, 7 Oct 2026, 15:00" in the reader's own language and 24-hour time. */
export function formatDisplay(p: LocalParts, locale?: string): string {
  const date = toDate(p);
  const day = formatter(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  return `${day}, ${pad(p.hour)}:${pad(p.minute)}`;
}

export function monthLabel(year: number, month: number, locale?: string): string {
  return formatter(locale, { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
}

/** Monday-first short weekday names, with the full name for screen readers. */
export function weekdayNames(locale?: string): Array<{ short: string; long: string }> {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2024, 0, 1 + i); // 1 January 2024 was a Monday
    return {
      short: formatter(locale, { weekday: 'short' }).format(d).slice(0, 2),
      long: formatter(locale, { weekday: 'long' }).format(d),
    };
  });
}

/** "Wednesday, 7 October 2026": a day's full name, for a screen reader. */
export function dayLabel(d: { year: number; month: number; day: number }, locale?: string): string {
  return formatter(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d.year, d.month - 1, d.day));
}

/** "GMT+1, Africa/Lagos" for the given moment: the offset can differ between summer and winter. */
export function timeZoneLabel(at: Date = new Date()): string {
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const offset = `GMT${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`;
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    zone = '';
  }
  return zone ? `${offset}, ${zone}` : offset;
}
