import { useState } from 'react';
import { chainById, explorerTxUrl } from '@stryx/chains';
import { SegmentedControl } from './SegmentedControl';
import {
  HISTORY_FILTERS,
  matchesFilter,
  outcomeOf,
  totalQuantity,
  type HistoryEntry,
  type HistoryFilter,
  type HistoryLeg,
} from '../lib/mint-history';
import { useCollectionName } from '../lib/useCollectionName';
import { CollectionAvatar } from './CollectionAvatar';
import { ChevronRightIcon } from '../lib/icons';
import { canCreateProof } from '../lib/proof-card';
import { Notice } from './Notice';

/** How many runs show before "Show more". */
const PAGE = 20;
const short = (v: string) => (v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

const LEG_PILL: Record<HistoryLeg['status'], { cls: 'live' | 'pending' | 'fail' | 'idle'; label: string }> = {
  confirmed: { cls: 'live', label: 'confirmed' },
  failed: { cls: 'fail', label: 'failed' },
  pending: { cls: 'pending', label: 'pending' },
  unconfirmed: { cls: 'idle', label: 'unconfirmed' },
};

export function LegRow({ leg, chainId }: { leg: HistoryLeg; chainId: number }) {
  const chain = chainById(chainId);
  const link = leg.hash && chain ? explorerTxUrl(chain, leg.hash) : undefined;
  const pill = LEG_PILL[leg.status];
  return (
    <li className="history-leg">
      <span className="mono history-leg__wallet" title={leg.address ?? leg.walletId}>
        {leg.address ? short(leg.address) : leg.walletId ? short(leg.walletId) : 'no wallet'}
      </span>
      <span className={`pill ${pill.cls}`}>{pill.label}</span>
      <span className="history-leg__detail">
        {leg.landedMs !== undefined && <span className="mono">{seconds(leg.landedMs)} after open</span>}
        {leg.hash &&
          (link ? (
            <a className="mono" href={link} target="_blank" rel="noreferrer noopener" title={leg.hash}>
              {short(leg.hash)}
              <span aria-hidden="true"> ↗</span>
              <span className="sr-only"> (opens the block explorer)</span>
            </a>
          ) : (
            <span className="mono" title={leg.hash}>
              {short(leg.hash)}
            </span>
          ))}
      </span>
      {leg.reason && (
        <Notice tone="error" compact className="history-leg__reason">
          {leg.reason}
        </Notice>
      )}
    </li>
  );
}

function HistoryCard({ entry, chainName, onProof }: { entry: HistoryEntry; chainName?: string; onProof?: (entry: HistoryEntry) => void }) {
  const [open, setOpen] = useState(false);
  const { name } = useCollectionName(entry.chainId, entry.nftContract);
  const chain = chainById(entry.chainId);
  const outcome = outcomeOf(entry);
  const wallets = new Set(entry.legs.map((l) => l.walletId || l.id)).size;
  const qty = totalQuantity(entry);
  const title = name ?? `Contract ${short(entry.nftContract)}`;
  const detailsId = `history-${entry.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const kindLabel = entry.kind === 'signed' ? (entry.stageLabel ? `Signed · ${entry.stageLabel}` : 'Signed') : entry.kind === 'scheduled' ? 'Scheduled' : 'Direct mint';

  return (
    <li className="history-card" data-outcome={outcome.cls}>
      <button type="button" className="history-card__head" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)}>
        <CollectionAvatar chainId={entry.chainId} contract={entry.nftContract} name={name} {...(chainName ? { chainName } : {})} />
        <span className="history-card__main">
          <b title={`${title} (${entry.nftContract})`}>{title}</b>
          <small>
            {chainName ?? chain?.name ?? `Chain ${entry.chainId}`} · {kindLabel} · {when(entry.at)}
          </small>
          <small>
            {entry.loading ? 'Loading results…' : `${wallets} wallet${wallets === 1 ? '' : 's'}${qty > 0 ? ` · ${qty} NFT${qty === 1 ? '' : 's'}` : ''}`}
          </small>
        </span>
        <span className={`pill ${outcome.cls}`}>{outcome.label}</span>
        <ChevronRightIcon className="history-card__chev" aria-hidden />
      </button>
      {open && (
        <ul id={detailsId} className="history-legs" aria-label={`Wallets for ${title}`}>
          {entry.legs.length === 0 ? <li className="history-leg history-leg--empty">No wallet results yet.</li> : entry.legs.map((leg) => <LegRow key={leg.id} leg={leg} chainId={entry.chainId} />)}
        </ul>
      )}
      {open && onProof && canCreateProof(entry) && (
        <div className="history-card__foot">
          <button type="button" className="primary" onClick={() => onProof(entry)}>
            Create proof card
          </button>
        </div>
      )}
    </li>
  );
}

/** Where the list comes from, for the note under it. */
export type HistoryScope =
  /** The account's mint log on the server (the same on every device); `since` is its first row. */
  | { kind: 'account'; since?: number }
  /** Only what this browser recorded (the server has no mint log, or it could not be reached). */
  | { kind: 'device'; since?: number };

/** Mint history: every run that has finished, newest first, filterable to the successful ones or the failed ones. */
export function MintHistory({
  entries,
  chainNames,
  loading,
  error,
  scope = { kind: 'device' },
  onProof,
  onLoadOlder,
  loadingOlder = false,
}: {
  entries: readonly HistoryEntry[];
  chainNames: ReadonlyMap<number, string>;
  loading: boolean;
  error?: string | null;
  scope?: HistoryScope;
  /** Present while the server holds older history than has been fetched. */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  /** Opens the proof card for a run. Offered on runs with at least one confirmed mint. */
  onProof?: (entry: HistoryEntry) => void;
}) {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [shown, setShown] = useState(PAGE);

  const visible = entries.filter((e) => matchesFilter(e, filter));
  const empty =
    filter === 'all'
      ? scope.kind === 'account'
        ? 'No finished mints yet. Every mint you schedule or fire shows up here once it runs, on any device you sign in on.'
        : 'No finished mints yet. Mints you schedule or fire from this device show up here once they run.'
      : filter === 'success' ? 'No successful mints yet.' : 'No failed mints. Nice.';

  return (
    <div className="history">
      <div className="history__bar">
        <SegmentedControl
          label="Show mints"
          options={HISTORY_FILTERS}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setShown(PAGE);
          }}
        />
        <span className="history__count" aria-live="polite">
          {visible.length} run{visible.length === 1 ? '' : 's'}
        </span>
      </div>

      {error && <Notice tone="error" className="history__error">{error}</Notice>}
      {loading && entries.length === 0 ? (
        <div className="history__skeleton" aria-busy="true" aria-label="Loading mint history">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 68 }} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="empty-state">{empty}</p>
      ) : (
        <>
          <ul className="history__list" aria-label="Mint history, newest first">
            {visible.slice(0, shown).map((entry) => (
              <HistoryCard key={entry.id} entry={entry} {...(onProof ? { onProof } : {})} {...(chainNames.get(entry.chainId) ? { chainName: chainNames.get(entry.chainId)! } : {})} />
            ))}
          </ul>
          {visible.length > shown ? (
            <button type="button" className="history__more" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({visible.length - shown} older)
            </button>
          ) : (
            onLoadOlder && (
              <button type="button" className="history__more" disabled={loadingOlder} onClick={onLoadOlder}>
                {loadingOlder ? 'Loading…' : 'Load older mints'}
              </button>
            )
          )}
        </>
      )}

      <p className="ops-note history__note">
        A run with both successes and failures shows under both filters.{' '}
        {scope.kind === 'account' ? (
          <>
            Saved to your account, so it is the same on every device you sign in on.
            {scope.since ? ` Mints before ${new Date(scope.since).toLocaleDateString()} come from this browser's own records.` : ''}
          </>
        ) : (
          <>
            This lists mints scheduled or fired from this device
            {scope.since ? ` (recorded here since ${new Date(scope.since).toLocaleDateString()})` : ''} and signed runs from the last 7 days.
          </>
        )}
      </p>
    </div>
  );
}
