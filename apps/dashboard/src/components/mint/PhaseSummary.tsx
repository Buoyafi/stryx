import { useSharedNow } from '../../lib/phase-clock';
import { countdownStatus } from '../../lib/countdown';
import { weiToEther } from '../../lib/wei-format';
import { weiToUsd } from '../../lib/native-price';
import type { AllowListMechanism } from '../../lib/collection-phases';

/** The totals and the single primary button for a public or Merkle allow-list phase. */
export function PhaseSummary({
  totalQuantity,
  totalWallets,
  totalCostWei,
  symbol,
  usdPerToken,
  showUsd,
  startMs,
  endMs,
  mechanism,
  onOpenReview,
}: {
  totalQuantity: number;
  totalWallets: number;
  totalCostWei: string | null;
  symbol: string;
  usdPerToken: number | null;
  showUsd: boolean;
  startMs: number | null;
  endMs: number | null;
  mechanism: AllowListMechanism | null;
  onOpenReview: () => void;
}) {
  const now = useSharedNow();
  const isLive = countdownStatus(now, startMs, endMs)?.phase === 'live';
  const usd = totalCostWei !== null ? weiToUsd(totalCostWei, usdPerToken) : null;
  const executable = mechanism === null || mechanism === 'merkle';
  const disabled = !executable || totalWallets === 0;
  const disabledReason = !executable ? 'This kind of phase cannot be minted from here' : totalWallets === 0 ? 'Select at least one wallet and set a quantity first' : undefined;

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dash-line-strong)' }}>
      <div style={{ fontSize: 12.5 }}>
        <div style={{ fontWeight: 600 }}>
          {totalQuantity} NFTs · {totalWallets} wallets
        </div>
        <div style={{ color: 'var(--stryx-sub)' }}>
          {totalCostWei !== null ? `${weiToEther(totalCostWei)} ${symbol}` : '-'}
          {showUsd && usd && ` (${usd})`} + gas
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <button type="button" className="primary" disabled={disabled} title={disabledReason} onClick={onOpenReview}>
          {isLive ? 'Mint now' : 'Schedule'}
        </button>
        {!executable && <div style={{ fontSize: 11, color: 'var(--stryx-sub)', marginTop: 4 }}>This kind of phase cannot be minted from here</div>}
      </div>
    </div>
  );
}
