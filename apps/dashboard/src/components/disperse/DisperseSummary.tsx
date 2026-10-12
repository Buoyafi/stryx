import type { ReactNode } from 'react';
import { formatWei } from '../../lib/units';

/**
 * The live summary next to (desktop) or above the bottom bar (phone) while composing: what will be
 * sent, how much, and why Review is not available yet.
 */
export function DisperseSummary(props: {
  chainName: string;
  symbol: string;
  from: string | null;
  recipients: number;
  /** Amount each, or null when every recipient has their own amount. */
  each: string | null;
  totalWei: bigint;
  ready: boolean;
  /** Why Review is off, in one short sentence. */
  whyNot: string | null;
  /** Notices to show above the button (the signing warning, a contract note). */
  children?: ReactNode;
  onReview: () => void;
}) {
  const { symbol } = props;
  return (
    <aside className="dsp-summary" aria-label="Summary">
      <div className="dsp-summary__head">
        <h2>Summary</h2>
        <span className="dsp-summary__total mono" aria-label="Total to send">
          {formatWei(props.totalWei)} {symbol}
        </span>
      </div>
      <dl className="dsp-summary__rows">
        <div>
          <dt>Chain</dt>
          <dd>{props.chainName || '-'}</dd>
        </div>
        <div>
          <dt>From</dt>
          <dd className="mono">{props.from ?? '-'}</dd>
        </div>
        <div>
          <dt>Recipients</dt>
          <dd className="mono">{props.recipients}</dd>
        </div>
        <div>
          <dt>Each</dt>
          <dd className="mono">{props.each === null ? 'varies' : `${props.each || '0'} ${symbol}`}</dd>
        </div>
      </dl>
      {props.children}
      <button type="button" className="primary dsp-summary__go" disabled={!props.ready} onClick={props.onReview}>
        Review
      </button>
      {props.whyNot && !props.ready && <p className="dsp-summary__why">{props.whyNot}</p>}
    </aside>
  );
}
