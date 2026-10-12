/**
 * The three bulk quantity actions, applied to every
 * currently-selected, eligible wallet in the open phase card.
 */
export function BulkActions({ onMaxSelected, onSetOne, onClear, disabled }: { onMaxSelected: () => void; onSetOne: () => void; onClear: () => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 12px' }}>
      <button type="button" onClick={onMaxSelected} disabled={disabled}>
        Max selected
      </button>
      <button type="button" onClick={onSetOne} disabled={disabled}>
        Set 1
      </button>
      <button type="button" onClick={onClear} disabled={disabled}>
        Clear
      </button>
    </div>
  );
}
