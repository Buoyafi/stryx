import { useEffect, useState } from 'react';

/** A nudge toward the next useful action: not a warning and not an event. */
export function GlowHint({
  visible,
  text,
  icon = '+',
  onActivate,
}: {
  visible: boolean;
  text: string;
  /** A single glyph shown in the leading circle. */
  icon?: string;
  onActivate?: () => void;
}) {
  const [mounted, setMounted] = useState(visible);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!mounted) return null;

  return (
    <button
      type="button"
      role="status"
      aria-label={text}
      className={`glow-hint${entered ? ' is-visible' : ''}`}
      onClick={onActivate}
    >
      <span className="glow-hint__icon" aria-hidden="true">
        {icon}
      </span>
      {text}
    </button>
  );
}
