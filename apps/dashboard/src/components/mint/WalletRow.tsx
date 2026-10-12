import { QuantityStepper } from '../QuantityStepper';
import { weiToEther } from '../../lib/wei-format';
import { weiToUsd } from '../../lib/native-price';
import { shortError } from '../../lib/short-error';
import { useSharedNow } from '../../lib/phase-clock';
import { countdownStatus } from '../../lib/countdown';
import { humanEligibilityReason, type WalletEligibilityRow } from '../../lib/mint-eligibility';

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const mulWei = (wei: string, qty: number): string => (BigInt(wei) * BigInt(qty)).toString();

/** The API's short reason for a failed live check, in plain words. */
function liveCheckLine(reason: string, symbol: string): string {
  if (reason === 'rpc_unavailable') return 'Live check could not run';
  if (/insufficient[ _]funds|exceeds the balance/i.test(reason)) return `Live check: would fail (not enough ${symbol})`;
  if (!reason || reason === 'reverted') return 'Live check: would fail (the contract refused it)';
  return `Live check: would fail (${shortError(reason, 60)})`;
}

/** One wallet's row inside an open phase card: checkbox, address, minted/max or why it is ineligible, and a quantity stepper. */
export function WalletRow({
  wallet,
  row,
  symbol,
  usdPerToken,
  showUsd,
  selected,
  onToggleSelect,
  quantity,
  isMax,
  onQuantityChange,
  onToggleMax,
  startMs,
  endMs,
}: {
  wallet: { id: string; address: string; label: string | null };
  /** Undefined while the eligibility check for this phase is still in flight. */
  row: WalletEligibilityRow | undefined;
  symbol: string;
  usdPerToken: number | null;
  showUsd: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  quantity: number;
  isMax: boolean;
  onQuantityChange: (next: number) => void;
  onToggleMax: () => void;
  /** The phase's timing, to tell "not started yet" from "already ended" when the reason is stage_not_active. */
  startMs: number | null;
  endMs: number | null;
}) {
  const now = useSharedNow();
  const phaseEnded = countdownStatus(now, startMs, endMs)?.phase === 'ended';
  const loading = !row;
  const eligible = row?.eligible === 'eligible';
  const effectiveQty = isMax ? (row?.remaining ?? 0) : quantity;
  const costWei = row?.priceWei && effectiveQty > 0 ? mulWei(row.priceWei, effectiveQty) : null;
  const usd = costWei !== null ? weiToUsd(costWei, usdPerToken) : null;
  const lowBalance = eligible && costWei !== null && row !== undefined && BigInt(row.balanceWei) < BigInt(costWei);

  const ineligibleReason = row?.eligible === 'not_eligible' ? (row.reason === 'not_on_allowlist' ? 'Not on list' : row.reason === 'at_mint_limit' ? 'Limit reached' : row.reason === 'stage_not_active' ? (phaseEnded ? 'Phase ended' : 'Phase not live yet') : humanEligibilityReason(row.reason) || 'Not eligible') : null;
  const unknownReason = row?.eligible === 'unknown' ? humanEligibilityReason(row.reason) || 'Could not be checked' : null;

  return (
    <div className="wallet-row">
      <input type="checkbox" aria-label={`Select ${shortAddress(wallet.address)}`} checked={selected} disabled={!eligible} onChange={onToggleSelect} />
      <div style={{ minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 12.5 }}>
          {wallet.label ? `${wallet.label} · ` : ''}
          {shortAddress(wallet.address)}
        </div>
        <div style={{ fontSize: 12, color: lowBalance ? 'var(--dash-fail-text)' : 'var(--stryx-sub)' }}>
          {loading && 'Checking…'}
          {!loading && ineligibleReason && `✕ ${ineligibleReason}`}
          {!loading && unknownReason && `? ${unknownReason}`}
          {!loading && eligible && (
            <>
              {row.minted}/{row.limit ?? '-'} minted
              {lowBalance && ' · Low balance'}
              {!lowBalance && costWei !== null && (
                <>
                  {' '}
                  · {weiToEther(costWei)} {symbol}
                  {showUsd && usd && <> ({usd})</>}
                </>
              )}
              {/* Eligible ahead of a phase that has not opened: wallets can be selected and quantities set before it goes live. */}
              {row.reason === 'stage_not_active' && (phaseEnded ? ' · Ended' : ' · Not live yet')}
            </>
          )}
        </div>
        {row?.simulation?.ok === false && (
          <div style={{ fontSize: 11, color: 'var(--dash-fail-text)', marginTop: 2 }} title={row.simulation.reason || undefined}>
            {liveCheckLine(row.simulation.reason ?? '', symbol)}
          </div>
        )}
      </div>
      {/* remaining is null for an uncapped phase: MAX has no target, so it is disabled. */}
      {eligible ? <QuantityStepper value={quantity} onChange={onQuantityChange} isMax={isMax} onToggleMax={onToggleMax} min={0} max={row.remaining ?? 50} disableMax={row.remaining === null} /> : <span />}
    </div>
  );
}
