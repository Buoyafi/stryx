import { useSharedNow } from '../../lib/phase-clock';
import { countdownStatus } from '../../lib/countdown';

/** The countdown badge that sits above the card as a flat-topped tab. */
export function PhaseCountdownTab({ startMs, endMs }: { startMs: number | null; endMs: number | null }) {
  const now = useSharedNow();
  const status = countdownStatus(now, startMs, endMs);
  if (!status) return <span className="phase-tab">Phase</span>;
  const label = status.phase === 'live' ? `Live · ${status.label}` : status.label.charAt(0).toUpperCase() + status.label.slice(1);
  return <span className={`phase-tab${status.phase === 'live' ? ' live' : ''}`}>{label}</span>;
}
