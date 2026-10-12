import { useEffect } from 'react';
import { apiRequest } from '../../lib/api';
import { weiToEther } from '../../lib/wei-format';
import { weiToUsd } from '../../lib/native-price';
import type { Phase } from '../../lib/collection-phases';
import { totalCostWei, type EligibleSelection } from '../../lib/mint-fire';
import { priorityFeeProblem } from '../../lib/priority-fee';
import { PriorityFeeField, type TipContext } from './PriorityFeeField';

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The last screen before anything is broadcast or scheduled: modeled on the disperse flow's own
 * ReviewStep (components/disperse/ReviewStep.tsx).
 */
export function MintReviewStep({
  phase,
  chainId,
  symbol,
  usdPerToken,
  showUsd,
  selection,
  live,
  confirming,
  onBack,
  onConfirm,
  priorityFeeGwei = '',
  onPriorityFeeChange,
  tipContext,
}: {
  phase: Phase;
  chainId: number;
  symbol: string;
  usdPerToken: number | null;
  showUsd: boolean;
  selection: readonly EligibleSelection[];
  /** Whether the phase is live right now: decides "Mint now" wording vs "Schedule for...". */
  live: boolean;
  confirming: boolean;
  onBack: () => void;
  onConfirm: () => void;
  /** The tip in gwei as typed; blank means the network's suggestion. */
  priorityFeeGwei?: string;
  /** Absent: no tip field (tests, or callers that do not offer one). */
  onPriorityFeeChange?: (v: string) => void;
  /** What the tip field's Suggest button looks back at. */
  tipContext?: TipContext;
}) {
  useEffect(() => {
    const walletIds = selection.map((s) => s.walletId);
    if (walletIds.length === 0) return;
    apiRequest(`/chains/${chainId}/wallets/warm-nonces`, { method: 'POST', body: { walletIds } }).catch(() => {});
    // Deliberately no cleanup/cancellation, and deliberately fires once on mount rather than depending
    // on `selection` (a fresh array reference every render): this component only exists while the
    // review step is open, so mount already means "the operator just landed here with this exact
    // selection," and re-warming on every incidental re-render (e.g. `confirming` toggling) would be
    // pure waste, not a correctness issue either way.
  }, []);

  const costWei = totalCostWei(selection);
  const usd = costWei !== null ? weiToUsd(costWei, usdPerToken) : null;
  const totalQuantity = selection.reduce((sum, s) => sum + s.quantity, 0);

  return (
    <div>
      <dl className="review-facts" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 18px', margin: '16px 0' }}>
        <dt style={{ color: 'var(--stryx-sub)' }}>Phase</dt>
        <dd>
          {phase.name} ({phase.kind === 'public' ? 'public' : 'Merkle allow-list'})
        </dd>
        <dt style={{ color: 'var(--stryx-sub)' }}>How</dt>
        <dd>
          {live
            ? `${selection.length} wallet${selection.length === 1 ? '' : 's'}, sent one after another. Nothing is undone if a later wallet fails.`
            : `${selection.length} wallet${selection.length === 1 ? '' : 's'}, scheduled to fire when the phase goes live.`}
        </dd>
        <dt style={{ color: 'var(--stryx-sub)' }}>Total</dt>
        <dd className="mono" style={{ fontWeight: 700 }}>
          {totalQuantity} NFT{totalQuantity === 1 ? '' : 's'} · {costWei !== null ? `${weiToEther(costWei)} ${symbol}` : 'price unknown'}
          {showUsd && usd && ` (${usd})`}
          {' + gas'}
        </dd>
      </dl>

      <table className="dense" aria-label="Wallets to mint from">
        <thead>
          <tr>
            <th>Wallet</th>
            <th>Quantity</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {selection.map((s) => (
            <tr key={s.walletId}>
              <td className="mono" title={s.address}>
                {shortAddress(s.address)}
              </td>
              <td className="mono">
                {s.quantity}
                {s.isMax && ' (max)'}
              </td>
              <td className="mono">{s.priceWei !== null ? `${weiToEther(s.priceWei)} ${symbol}` : 'unknown'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {onPriorityFeeChange && (
        <div style={{ marginTop: 14 }}>
          <PriorityFeeField chainId={chainId} symbol={symbol} value={priorityFeeGwei} onChange={onPriorityFeeChange} {...(tipContext ? { tipContext } : {})} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 18, alignItems: 'center' }}>
        <button type="button" onClick={onBack} disabled={confirming}>
          Back
        </button>
        <button type="button" className="primary" disabled={confirming || selection.length === 0 || priorityFeeProblem(chainId, priorityFeeGwei) !== null} onClick={onConfirm}>
          {confirming ? 'Working…' : live ? 'Confirm and mint' : 'Confirm and schedule'}
        </button>
        <span style={{ color: 'var(--stryx-sub)', fontSize: 12 }}>{live ? 'Nothing is sent until you press this.' : 'Nothing is scheduled until you press this.'}</span>
      </div>
    </div>
  );
}
