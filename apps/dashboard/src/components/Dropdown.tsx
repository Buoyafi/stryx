import { useEffect, useId, useRef, useState } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
}

const TYPEAHEAD_RESET_MS = 600;
/** A rough per-option height, only for guessing whether the panel should open upward. */
const ESTIMATED_OPTION_HEIGHT = 32;
const PANEL_MAX_HEIGHT = 260;

/** A replacement for a native `<select>`, whose popup cannot be styled: a real listbox. */
export function Dropdown({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  id,
  'aria-label': ariaLabel,
  style,
}: {
  options: readonly DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
  /** Applied to the root wrapper. */
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [openUpward, setOpenUpward] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ buffer: '', timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const listboxId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  // Close on outside click; Escape is handled on the trigger, which keeps focus.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Keep the highlighted option scrolled into view as it moves via keyboard.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[highlighted] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted, open]);

  function openMenu() {
    setHighlighted(selectedIndex >= 0 ? selectedIndex : 0);
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const estimatedHeight = Math.min(PANEL_MAX_HEIGHT, options.length * ESTIMATED_OPTION_HEIGHT + 8);
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setOpenUpward(spaceBelow < estimatedHeight && spaceAbove > spaceBelow);
    }
    setOpen(true);
  }

  function commit(index: number) {
    const opt = options[index];
    if (opt) onChange(opt.value);
    setOpen(false);
  }

  function typeaheadJump(key: string) {
    typeahead.current.buffer += key.toLowerCase();
    clearTimeout(typeahead.current.timer);
    typeahead.current.timer = setTimeout(() => {
      typeahead.current.buffer = '';
    }, TYPEAHEAD_RESET_MS);
    const match = options.findIndex((o) => o.label.toLowerCase().startsWith(typeahead.current.buffer));
    if (match >= 0) setHighlighted(match);
  }

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlighted((h) => Math.min(options.length - 1, h + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlighted((h) => Math.max(0, h - 1));
        break;
      case 'Home':
        e.preventDefault();
        setHighlighted(0);
        break;
      case 'End':
        e.preventDefault();
        setHighlighted(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(highlighted);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (e.key.length === 1) typeaheadJump(e.key);
    }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%', ...style }}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-opt-${highlighted}` : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          textAlign: 'left',
          // Matches the app's input look, not the raised button style.
          background: 'var(--stryx-bg)',
          color: 'var(--stryx-ink)',
          border: '1px solid var(--dash-line-strong)',
          borderRadius: 'var(--radius)',
          padding: '8px 10px',
          fontWeight: 400,
        }}
      >
        <span style={{ color: selected ? 'var(--stryx-ink)' : 'var(--stryx-sub)' }}>{selected?.label ?? placeholder}</span>
        <span style={{ color: 'var(--stryx-sub)', fontSize: 10 }}>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          id={listboxId}
          aria-label={ariaLabel}
          className="stryx-scroll"
          style={{
            position: 'absolute',
            ...(openUpward ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
            left: 0,
            right: 0,
            zIndex: 20,
            margin: 0,
            padding: 4,
            listStyle: 'none',
            background: 'var(--stryx-card)',
            border: '1px solid var(--dash-line-strong)',
            borderRadius: 'var(--radius)',
            maxHeight: PANEL_MAX_HEIGHT,
            overflowY: 'auto',
            boxShadow: 'var(--dash-shadow)',
          }}
        >
          {options.length === 0 ? (
            <li style={{ padding: '8px 10px', color: 'var(--stryx-sub)', fontSize: 12.5 }}>No options.</li>
          ) : (
            options.map((opt, i) => (
              <li
                key={opt.value}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={opt.value === value}
                onMouseEnter={() => setHighlighted(i)}
                onMouseDown={(e) => {
                  // Focus stays on the trigger the whole time.
                  e.preventDefault();
                  commit(i);
                }}
                style={{
                  padding: '8px 10px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: i === highlighted ? 'var(--dash-raised)' : 'transparent',
                  color: 'var(--stryx-ink)',
                  fontSize: 12.5,
                }}
              >
                {opt.label}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
