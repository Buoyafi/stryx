import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PhaseCard } from './PhaseCard';
import { Switch } from './Switch';
import { countdownStatus } from '../../lib/countdown';
import { fetchCollectionPhases, type Phase } from '../../lib/collection-phases';
import { sortPhasesChronologically } from '../../lib/phase-order';
import { fetchNativePrice } from '../../lib/native-price';
import { readUsdToggle, writeUsdToggle } from '../../lib/native-price';
import { apiRequest } from '../../lib/api';
import { Notice } from '../Notice';

/** Which phase, if any, should start expanded: the live one, or else the next upcoming one. */
function pickDefaultOpenPhaseId(phases: readonly Phase[], now: number): string | null {
  const live = phases.find((p) => countdownStatus(now, p.startMs, p.endMs)?.phase === 'live');
  if (live) return live.id;
  const upcoming = phases.find((p) => countdownStatus(now, p.startMs, p.endMs)?.phase === 'before');
  return upcoming?.id ?? null;
}

interface WalletLite {
  id: string;
  address: string;
  label: string | null;
  status: string;
}

/**
 * How often the phase list re-checks itself: phases don't change often, but a countdown crossing from
 * "starts in" to "live" should reflect in the chips list (not just the per-card ticking countdown
 * text) within a reasonable window.
 */
const PHASES_REFRESH_MS = 30_000;
/** While OpenSea's stages are missing or stale, ask again this often, so they come back on their own. */
const PHASES_RETRY_MS = 5_000;

/** Every phase of the resolved collection, with the "Show ended" and USD toggles. */
export function PhaseList({ chainId, contract, symbol, slug = null }: { chainId: number; contract: string; symbol: string; slug?: string | null }) {
  const [showEnded, setShowEnded] = useState(false);
  const [showUsd, setShowUsd] = useState(() => readUsdToggle());

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['collection-phases', chainId, contract],
    queryFn: () => fetchCollectionPhases(chainId, contract),
    refetchInterval: (q) => {
      const status = q.state.data?.openSea;
      return status === 'unavailable' || status === 'stale' ? PHASES_RETRY_MS : PHASES_REFRESH_MS;
    },
  });
  const openSea = data?.openSea ?? 'ok';
  const { data: priceReading } = useQuery({
    queryKey: ['native-price', chainId],
    queryFn: () => fetchNativePrice(chainId),
    enabled: showUsd,
    staleTime: 30_000,
  });
  // Shared by every phase card: one fetch here, not one per card.
  const { data: walletsRaw } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => apiRequest<WalletLite[]>('/wallets'),
    staleTime: 30_000,
  });
  const wallets = (walletsRaw ?? []).filter((w) => w.status === 'ACTIVE');

  const toggleUsd = () => {
    setShowUsd((v) => {
      writeUsdToggle(!v);
      return !v;
    });
  };

  const phases = sortPhasesChronologically(data?.phases ?? []);
  const now = Date.now();
  // A phase that ends while on screen stays: its card may hold a mint's results or a review in progress.
  const shown = useRef(new Set<string>());
  const visible = showEnded ? phases : phases.filter((p) => shown.current.has(p.id) || countdownStatus(now, p.startMs, p.endMs)?.phase !== 'ended');
  for (const p of phases) if (countdownStatus(now, p.startMs, p.endMs)?.phase !== 'ended') shown.current.add(p.id);
  const defaultOpenPhaseId = pickDefaultOpenPhaseId(phases, now);

  return (
    <section aria-label="Phases" style={{ marginTop: 24, maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ fontSize: 14 }}>Phases</h2>
        <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: 'var(--stryx-sub)' }}>
          <Switch checked={showEnded} onChange={() => setShowEnded((v) => !v)} label="Show ended" />
          <Switch checked={showUsd} onChange={toggleUsd} label="USD" />
        </div>
      </div>

      {isLoading && <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5 }}>Loading phases…</p>}

      {!isLoading && openSea === 'unavailable' && (
        <Notice
          tone="error"
          action={
            <button type="button" disabled={isFetching} onClick={() => void refetch()}>
              {isFetching ? 'Retrying…' : 'Retry now'}
            </button>
          }
        >
          Can't reach OpenSea, so GTD and FCFS phases may be missing.
        </Notice>
      )}
      {!isLoading && openSea === 'stale' && (
        <Notice tone="warn">{`OpenSea isn't answering. Showing its stages from ${data?.openSeaAsOf ? new Date(data.openSeaAsOf).toLocaleTimeString() : 'earlier'}.`}</Notice>
      )}

      {!isLoading && phases.length === 0 && (
        <div className="empty-state">
          <div style={{ marginBottom: 6, color: 'var(--stryx-ink)' }}>No phases configured</div>
          <div style={{ fontSize: 12.5 }}>This contract has no active or upcoming mint phase yet.</div>
        </div>
      )}

      {!isLoading && phases.length > 0 && visible.length === 0 && (
        <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5 }}>
          Every phase has ended. <button type="button" onClick={() => setShowEnded(true)} style={{ fontSize: 12.5 }}>Show ended</button>
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {visible.map((phase) => (
          <PhaseCard key={phase.id} phase={phase} symbol={symbol} usdPerToken={priceReading?.usdPerToken ?? null} showUsd={showUsd} chainId={chainId} contract={contract} slug={slug} wallets={wallets} dropPhases={phases} defaultOpen={phase.id === defaultOpenPhaseId} />
        ))}
      </div>
    </section>
  );
}
