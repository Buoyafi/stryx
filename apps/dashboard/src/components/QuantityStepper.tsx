import { useState } from 'react';

/** A −/+ stepper with a MAX toggle. */
export function QuantityStepper({
  value,
  onChange,
  isMax,
  onToggleMax,
  min = 1,
  max = 50,
  disableMax,
}: {
  value: number;
  onChange: (next: number) => void;
  isMax: boolean;
  onToggleMax: () => void;
  min?: number;
  max?: number;
  /** e.g. a pasted proof carries no known stage limit to resolve "max" against. */
  disableMax?: boolean;
}) {
  // What is being typed, kept apart from the committed number so the field can be cleared and retyped.
  const [draft, setDraft] = useState<string | null>(null);
  const parse = (text: string): number | null => {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const commit = () => {
    const n = draft === null ? null : parse(draft);
    if (n !== null) onChange(Math.min(max, Math.max(min, n)));
    setDraft(null);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={isMax || value <= min}
        style={{ width: 28, padding: 0, fontSize: 16, lineHeight: 1 }}
      >
        −
      </button>
      <input
        className="mono"
        aria-label="Quantity per wallet"
        style={{ width: 56, textAlign: 'center' }}
        inputMode="numeric"
        value={isMax ? 'MAX' : (draft ?? String(value))}
        disabled={isMax}
        onChange={(e) => {
          setDraft(e.target.value);
          // A number already in range takes effect at once; anything else waits for blur.
          const n = parse(e.target.value);
          if (n !== null && n >= min && n <= max) onChange(n);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={isMax || value >= max}
        style={{ width: 28, padding: 0, fontSize: 16, lineHeight: 1 }}
      >
        +
      </button>
      <button
        type="button"
        onClick={onToggleMax}
        disabled={disableMax}
        style={{
          fontSize: 11,
          padding: '4px 10px',
          borderColor: isMax ? 'var(--stryx-accent)' : 'var(--dash-line-strong)',
          background: isMax ? 'var(--dash-raised)' : 'transparent',
        }}
      >
        MAX
      </button>
    </div>
  );
}
