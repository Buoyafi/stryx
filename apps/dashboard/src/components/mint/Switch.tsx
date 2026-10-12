/** A pill toggle switch: a small track with a sliding knob. */
export function Switch({ checked, onChange, label, labelPosition = 'after' }: { checked: boolean; onChange: () => void; label: string; labelPosition?: 'before' | 'after' | 'none' }) {
  const knob = (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch${checked ? ' is-on' : ''}`} onClick={onChange}>
      <i className="switch__knob" />
    </button>
  );

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {labelPosition === 'before' && label}
      {knob}
      {labelPosition === 'after' && label}
    </span>
  );
}
