import { useState, type ReactNode } from 'react';
import { redactUrls, shortError } from '../lib/short-error';

export type NoticeTone = 'error' | 'warn' | 'ok' | 'info';

const PATHS: Record<NoticeTone, ReactNode> = {
  error: <path d="M6 6l8 8M14 6l-8 8" />,
  warn: <path d="M10 5.5v5.5M10 14.2v.1" />,
  ok: <path d="m5.5 10.5 3 3 6-6.5" />,
  info: <path d="M10 9v5.2M10 5.9v.1" />,
};

/**
 * A message the person should see, contained in a soft tinted box with an icon: an error, a warning, a
 * success or a plain note.
 */
export function Notice({
  tone = 'error',
  children,
  max = 110,
  compact = false,
  className,
  detail,
  action,
  role,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  /** Longest text shown before "Details". */
  max?: number;
  compact?: boolean;
  className?: string;
  /** The longer explanation, shown under the message when "Details" is pressed. */
  detail?: string;
  /** A button that goes with the message, at its right. */
  action?: ReactNode;
  /** Overrides the default: errors are `alert`, everything else `status`. */
  role?: 'alert' | 'status' | 'note';
}) {
  const [open, setOpen] = useState(false);
  const raw = typeof children === 'string' ? redactUrls(children) : null;
  const cut = raw !== null && (raw.length > max || raw.includes('\n'));
  const long = cut || !!detail;
  const shown: ReactNode = raw === null ? children : cut && !open ? shortError(raw, max) : raw;

  return (
    <div
      className={`notice notice--${tone}${compact ? ' notice--compact' : ''}${className ? ` ${className}` : ''}`}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      {...(cut && !open && raw ? { title: raw } : {})}
    >
      <svg className="notice__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="10" cy="10" r="8.2" strokeWidth="1.5" />
        {PATHS[tone]}
      </svg>
      <span className="notice__text">
        {shown}
        {detail && open && <span className="notice__detail">{redactUrls(detail)}</span>}
      </span>
      {action}
      {long && (
        <button type="button" className="notice__more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Less' : 'Details'}
        </button>
      )}
    </div>
  );
}
