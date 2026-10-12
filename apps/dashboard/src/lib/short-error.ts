const DEFAULT_MAX = 80;

// Chain-client errors append a block of request context after the first line.
const BOILERPLATE = /\s*(Request Arguments:|Contract Call:|Details:|Version:|Docs:)/;

/** Reduces an error to one short line for display. */
export function shortError(raw: string | null | undefined, max = DEFAULT_MAX): string {
  if (!raw) return '';
  const firstLine = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const trimmed = (firstLine.split(BOILERPLATE)[0] ?? '').replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:]+$/, '')}…`;
}

/** Replaces any URL in a message with "[url]". */
export { redactUrls } from '@stryx/utils/redact-urls';
