import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UnlockedIcon, LockedIcon } from '../../lib/icons';
import { weiToEther } from '../../lib/wei-format';
import { shortAddress } from '../../lib/admin-overview';
import { weiToUsd } from '../../lib/native-price';
import { ApiError } from '../../lib/api';
import { checkPhaseEligibility, type WalletEligibilityRow } from '../../lib/mint-eligibility';
import type { Phase } from '../../lib/collection-phases';
import { countdownStatus } from '../../lib/countdown';
import { resolveSelection, totalCostWei as computeTotalCostWei, fireNow, scheduleAll, type MintFireRow } from '../../lib/mint-fire';
import { mintFeedStore } from '../../lib/mint-feed-store';
import { deviceMintsFromResults } from '../../lib/mint-ops';
import { SERVER_MINTS_KEY } from '../../lib/server-mints';
import { PhaseCountdownTab } from './PhaseCountdownTab';
import { WalletRow } from './WalletRow';
import { BulkActions } from './BulkActions';
import { PhaseSummary } from './PhaseSummary';
import { MintReviewStep } from './MintReviewStep';
import { MintResultsView } from './MintResultsView';
import { SignedMintPanel } from './SignedMintPanel';
import type { TipContext } from './PriorityFeeField';
import { pastPhases } from '../../lib/tip-suggestion';

interface WalletLite {
  id: string;
  address: string;
  label: string | null;
}

/** One phase: a countdown tab above a card. */
export function PhaseCard({
  phase,
  symbol,
  usdPerToken,
  showUsd,
  chainId,
  contract,
  slug,
  wallets,
  dropPhases = [],
  defaultOpen = false,
}: {
  phase: Phase;
  symbol: string;
  usdPerToken: number | null;
  showUsd: boolean;
  chainId: number;
  contract: string;
  slug: string | null;
  wallets: readonly WalletLite[];
  /** Every phase of the drop: the tip field's Suggest button looks back at the ones already open. */
  dropPhases?: readonly Phase[];
  /**
   * Whether THIS phase should start expanded: PhaseList picks one (the live phase, or else the next
   * upcoming one) once, when phases first load.
   */
  defaultOpen?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [maxFlags, setMaxFlags] = useState<Record<string, boolean>>({});
  const [step, setStep] = useState<'list' | 'review' | 'results'>('list');
  const [confirming, setConfirming] = useState(false);
  const [priorityFeeGwei, setPriorityFeeGwei] = useState('');
  const [resultRows, setResultRows] = useState<MintFireRow[]>([]);
  const seededRef = useRef(false);

  const walletIds = wallets.map((w) => w.id);
  // Worked out when a review opens (not cached), so a phase that opened since still counts.
  const tipContext = (): TipContext => ({ contract, pastPhases: pastPhases(dropPhases, Date.now()) });
  const {
    data: outcome,
    error: eligError,
    isLoading: eligLoading,
  } = useQuery({
    queryKey: ['phase-eligibility', chainId, contract, phase.id, walletIds],
    queryFn: () => checkPhaseEligibility(chainId, contract, { slug, walletIds, phase }),
    // Fetches on mount, not when the card is opened, so the eligible count shows on the
    // collapsed card. A signed stage's check is only made when the server has it switched on.
    enabled: walletIds.length > 0,
    staleTime: 20_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // The API reports a preflight error (missing_slug, unsupported_mechanism, signed_mint_disabled, ...)
  // as a 4xx, the same way mint-preview-controller.ts's own preflightError already does: apiRequest
  // throws an ApiError for that, so useQuery surfaces it as `error`, never as `data`.
  const preflight =
    outcome?.preflightError
      ? { code: outcome.preflightError, detail: outcome.detail }
      : eligError instanceof ApiError && typeof (eligError.body as { error?: unknown } | null)?.error === 'string'
        ? { code: (eligError.body as { error: string }).error, detail: (eligError.body as { message?: string }).message }
        : null;

  useEffect(() => {
    seededRef.current = false;
  }, [phase.id, open]);

  // Collapsing the card, or switching to a different phase, abandons any in-progress review/results
  // view: neither carries state worth resuming across that (a stale review of a selection that may
  // have since changed), and this mirrors the disperse wizard's own reset-on-navigate-away behavior.
  useEffect(() => {
    setStep('list');
    setResultRows([]);
  }, [phase.id, open]);

  useEffect(() => {
    if (!outcome || outcome.preflightError || seededRef.current) return;
    seededRef.current = true;
    setSelected(new Set(outcome.results.filter((r) => r.eligible === 'eligible').map((r) => r.walletId)));
  }, [outcome]);

  // A signed stage is scheduled through its own panel (SignedMintPanel): its mint only exists once
  // OpenSea issues it at the stage start, so there is no per-wallet "mint now" here.
  const isSigned = phase.mechanism === 'signed';
  // Priced in an ERC-20: its amount is not in the native token's units, so it is never shown as ETH.
  const tokenPriced = phase.priceToken !== undefined && phase.priceWei !== null && phase.priceWei !== '0';
  const usd = phase.priceWei !== null && showUsd && !tokenPriced ? weiToUsd(phase.priceWei, usdPerToken) : null;
  const rowsByWallet = new Map<string, WalletEligibilityRow>((outcome?.results ?? []).map((r) => [r.walletId, r]));
  const eligibleCount = outcome && !outcome.preflightError ? outcome.results.filter((r) => r.eligible === 'eligible').length : null;

  const forEachSelectedEligible = (fn: (id: string) => void) => {
    selected.forEach((id) => {
      if (rowsByWallet.get(id)?.eligible === 'eligible') fn(id);
    });
  };

  const selection = resolveSelection(selected, quantities, maxFlags, rowsByWallet);
  const totalQuantity = selection.reduce((sum, s) => sum + s.quantity, 0);
  const totalWallets = selection.length;
  const totalCostWei = computeTotalCostWei(selection);

  const handleConfirm = async () => {
    setConfirming(true);
    const live = countdownStatus(Date.now(), phase.startMs, phase.endMs)?.phase === 'live';
    const ctx = { nftContract: contract, chainId, phase, slug, priorityFeeGwei };
    const rows = live ? await fireNow(ctx, selection) : await scheduleAll(ctx, selection);
    if (live) {
      // Only sent/failed rows are real device-recorded mints: a skipped one (a halted batch, or an
      // isMax wallet that resolved to 0 server-side) never attempted a broadcast, so recording it
      // would show a phantom failure on the Operations feed.
      const attempted = rows.filter((r): r is MintFireRow & { status: 'sent' | 'failed' | 'unknown' } => r.status === 'sent' || r.status === 'failed' || r.status === 'unknown');
      mintFeedStore.recordMints(deviceMintsFromResults(attempted.map((r) => ({ walletId: r.walletId, address: r.address, status: r.status, quantity: r.quantity, hash: r.hash, error: r.detail })), { chainId, nftContract: contract, now: Date.now() }));
      // The server's mint log has these now; Activity should show them without waiting for its next poll.
      void queryClient.invalidateQueries({ queryKey: SERVER_MINTS_KEY });
    }
    setResultRows(rows);
    setConfirming(false);
    setStep('results');
    // Cleared after any completed attempt, same reasoning as the old page: a "failed" row may still
    // have been broadcast (a timed-out response, not a rejection), so leaving it selected puts a
    // double mint one click away.
    setSelected(new Set());
  };

  return (
    <div style={{ marginBottom: 4 }}>
      <PhaseCountdownTab startMs={phase.startMs} endMs={phase.endMs} />
      <div className={`phase-card${open ? ' is-open' : ''}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: 0, minHeight: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
            {phase.kind === 'public' ? <UnlockedIcon aria-hidden /> : <LockedIcon aria-hidden />}
            {phase.name}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="chip">
              Price ·{' '}
              <b>
                {tokenPriced ? `Paid in token ${shortAddress(phase.priceToken!)}` : phase.priceWei !== null ? `${weiToEther(phase.priceWei)} ${symbol}` : 'Free'}
                {usd && ` (${usd})`}
                {showUsd && phase.priceWei !== null && !tokenPriced && usdPerToken === null && ' (USD unavailable)'}
              </b>
            </span>
            <span className="chip">
              Max/wallet · <b>{phase.maxPerWallet ?? '-'}</b>
            </span>
            <span className="chip">
              Eligible · <b>{preflight ? 'unavailable' : eligibleCount !== null ? `${eligibleCount}/${wallets.length}` : 'checking…'}</b>
            </span>
          </div>
        </button>

        {open && isSigned && wallets.length === 0 && (
          <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginTop: 12 }}>No active wallets. Create one on the Wallets page first.</p>
        )}

        {open && isSigned && wallets.length > 0 && (
          <>
            {preflight && <p style={{ color: 'var(--stryx-sub)', fontSize: 12, marginTop: 12 }}>Eligibility not shown: {preflight.detail ?? preflight.code} OpenSea answers for each wallet when the stage opens.</p>}
            <SignedMintPanel phase={phase} chainId={chainId} contract={contract} slug={slug} wallets={wallets} symbol={symbol} eligibility={rowsByWallet} tipContext={tipContext()} />
          </>
        )}

        {open && !isSigned && (
          <>
            {wallets.length === 0 && <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginTop: 12 }}>No active wallets. Create one on the Wallets page first.</p>}

            {wallets.length > 0 && preflight && <p style={{ color: 'var(--dash-fail-text)', fontSize: 12.5, marginTop: 12 }}>{preflight.detail ?? preflight.code}</p>}

            {wallets.length > 0 && !preflight && step === 'list' && (
              <>
                <BulkActions
                  disabled={eligLoading || selected.size === 0}
                  onMaxSelected={() => setMaxFlags((prev) => { const next = { ...prev }; forEachSelectedEligible((id) => { next[id] = true; }); return next; })}
                  onSetOne={() => {
                    setMaxFlags((prev) => { const next = { ...prev }; forEachSelectedEligible((id) => { next[id] = false; }); return next; });
                    setQuantities((prev) => { const next = { ...prev }; forEachSelectedEligible((id) => { next[id] = 1; }); return next; });
                  }}
                  onClear={() => {
                    setMaxFlags((prev) => { const next = { ...prev }; forEachSelectedEligible((id) => { next[id] = false; }); return next; });
                    setQuantities((prev) => { const next = { ...prev }; forEachSelectedEligible((id) => { next[id] = 0; }); return next; });
                  }}
                />

                {wallets.map((w) => (
                  <WalletRow
                    key={w.id}
                    wallet={w}
                    row={rowsByWallet.get(w.id)}
                    symbol={symbol}
                    usdPerToken={usdPerToken}
                    showUsd={showUsd}
                    selected={selected.has(w.id)}
                    onToggleSelect={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(w.id)) next.delete(w.id);
                        else next.add(w.id);
                        return next;
                      })
                    }
                    quantity={quantities[w.id] ?? 0}
                    isMax={maxFlags[w.id] ?? false}
                    onQuantityChange={(n) => setQuantities((prev) => ({ ...prev, [w.id]: n }))}
                    onToggleMax={() => setMaxFlags((prev) => ({ ...prev, [w.id]: !prev[w.id] }))}
                    startMs={phase.startMs}
                    endMs={phase.endMs}
                  />
                ))}

                <PhaseSummary
                  totalQuantity={totalQuantity}
                  totalWallets={totalWallets}
                  totalCostWei={totalCostWei}
                  symbol={symbol}
                  usdPerToken={usdPerToken}
                  showUsd={showUsd}
                  startMs={phase.startMs}
                  endMs={phase.endMs}
                  mechanism={phase.mechanism}
                  onOpenReview={() => setStep('review')}
                />
              </>
            )}

            {wallets.length > 0 && !preflight && step === 'review' && (
              <MintReviewStep
                phase={phase}
                chainId={chainId}
                symbol={symbol}
                usdPerToken={usdPerToken}
                showUsd={showUsd}
                selection={selection}
                live={countdownStatus(Date.now(), phase.startMs, phase.endMs)?.phase === 'live'}
                confirming={confirming}
                onBack={() => setStep('list')}
                onConfirm={() => void handleConfirm()}
                priorityFeeGwei={priorityFeeGwei}
                onPriorityFeeChange={setPriorityFeeGwei}
                tipContext={tipContext()}
              />
            )}

            {wallets.length > 0 && !preflight && step === 'results' && (
              <MintResultsView
                rows={resultRows}
                chainId={chainId}
                onClose={() => setStep('list')}
              />
            )}
          </>
        )}
      </div>

      {phase.source === 'opensea' && phase.kind === 'allowlist' && (
        <p style={{ color: 'var(--stryx-sub)', fontSize: 12, margin: '8px 0 0' }}>Price and limit as reported by OpenSea, not yet confirmed on-chain.</p>
      )}
    </div>
  );
}
