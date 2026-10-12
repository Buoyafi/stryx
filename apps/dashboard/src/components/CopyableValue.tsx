import { useState } from 'react';

/** Shows a shortened value that copies the full value on click. */
function copyWithTextarea(value: string): boolean {
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function CopyableValue({
  value,
  display,
  title,
}: {
  value: string;
  /** What to show. Defaults to a truncated middle-ellipsis form. */
  display?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);

  const shown = display ?? (value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);

  async function copy(e: React.MouseEvent) {
    // Stop the click bubbling to a parent row handler (e.g. row expansion).
    e.stopPropagation();
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      // No Clipboard API outside a secure context: fall back to the old copy command.
      ok = copyWithTextarea(value);
    }
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      onClick={copy}
      title={title ?? `Copy ${value}`}
      style={{
        border: 'none',
        background: 'transparent',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      }}
    >
      <span data-value className="mono">{shown}</span>
      <span
        aria-hidden
        style={{
          fontSize: 11,
          color: copied ? 'var(--dash-live-text)' : 'var(--stryx-sub)',
          transition: 'color 0.12s',
        }}
      >
        {copied ? '✓ copied' : '⧉'}
      </span>
    </button>
  );
}
