import { useState } from 'react';
import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';
import { chainById } from '@stryx/chains';
import { LegRow } from './MintHistory';
import { countLegs, outcomeOf, totalQuantity, type HistoryEntry } from '../lib/mint-history';
import { canCreateProof, durationLabel } from '../lib/proof-card';
import { useCollectionName } from '../lib/useCollectionName';

/** A run counts as "just finished" for this long after it ran. */
export const JUST_FINISHED_MS = 24 * 60 * 60_000;
/** The most cards shown; everything older or beyond this is in Mint history. */
export const JUST_FINISHED_MAX = 3;

export function justFinished(entries: readonly HistoryEntry[], now: number): HistoryEntry[] {
  return entries.filter((e) => !e.loading && e.legs.length > 0 && now - e.at <= JUST_FINISHED_MS && e.at <= now + 60_000).slice(0, JUST_FINISHED_MAX);
}

const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;

function ago(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function FinishedCard({ entry, now, chainName, onProof }: { entry: HistoryEntry; now: number; chainName?: string; onProof: (entry: HistoryEntry) => void }) {
  const [open, setOpen] = useState(false);
  const { name } = useCollectionName(entry.chainId, entry.nftContract);
  const chain = chainById(entry.chainId);
  const outcome = outcomeOf(entry);
  const counts = countLegs(entry.legs);
  const title = name ?? `Contract ${short(entry.nftContract)}`;
  const confirmedQty = totalQuantity({ ...entry, legs: entry.legs.filter((l) => l.status === 'confirmed') });
  const landed = entry.legs.map((l) => l.landedMs).filter((v): v is number => v !== undefined && counts.confirmed > 0);
  const kind = entry.kind === 'signed' ? `Signed${entry.stageLabel ? ` · ${entry.stageLabel}` : ''}` : entry.kind === 'scheduled' ? 'Scheduled' : 'Direct mint';
  const detailsId = `finished-${entry.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return (
    <article className="finished-card" aria-label={`${title}, ${outcome.label}`}>
      <header className="finished-card__head">
        <span className="finished-card__icon">
          <ChainIcon chain={viewForChainId(entry.chainId, chainName ?? chain?.name)} interactive={false} />
        </span>
        <div className="finished-card__title">
          <h3 title={`${title} (${entry.nftContract})`}>{title}</h3>
          <small>
            {chainName ?? chain?.name ?? `Chain ${entry.chainId}`} · {kind}
          </small>
        </div>
        <span className={`pill ${outcome.cls}`}>{counts.failed === 0 && counts.pending === 0 ? 'done' : counts.confirmed > 0 ? 'partly done' : 'failed'}</span>
      </header>
      <dl className="finished-card__facts">
        <div>
          <dt>Result</dt>
          <dd>{outcome.label}</dd>
        </div>
        <div>
          <dt>Minted</dt>
          <dd className="mono">{confirmedQty > 0 ? `${confirmedQty} NFT${confirmedQty === 1 ? '' : 's'}` : '-'}</dd>
        </div>
        <div>
          <dt>{landed.length > 0 ? 'Landed' : 'Ran'}</dt>
          <dd className="mono">{landed.length > 0 ? `${durationLabel(Math.max(...landed))} after open` : ago(now - entry.at)}</dd>
        </div>
        <div>
          <dt>Wallets</dt>
          <dd className="mono">{new Set(entry.legs.map((l) => l.walletId || l.id)).size}</dd>
        </div>
      </dl>
      <div className="finished-card__btns">
        {canCreateProof(entry) && (
          <button type="button" className="primary" onClick={() => onProof(entry)}>
            Create proof card
          </button>
        )}
        <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide details' : 'Details'}
        </button>
      </div>
      {open && (
        <ul id={detailsId} className="history-legs finished-card__legs" aria-label={`Wallets for ${title}`}>
          {entry.legs.map((leg) => (
            <LegRow key={leg.id} leg={leg} chainId={entry.chainId} />
          ))}
        </ul>
      )}
    </article>
  );
}

/** The runs that finished in the last day, as cards you can act on: create the proof card, or see each wallet's result. */
export function JustFinished({ entries, now, chainNames, onProof }: { entries: readonly HistoryEntry[]; now: number; chainNames: ReadonlyMap<number, string>; onProof: (entry: HistoryEntry) => void }) {
  const recent = justFinished(entries, now);
  if (recent.length === 0) return null;
  return (
    <section className="ops-section" aria-labelledby="ops-finished">
      <div className="ops-section__head">
        <h2 id="ops-finished">Just finished</h2>
        <span className="home__count">{recent.length}</span>
      </div>
      <div className="ops-grid">
        {recent.map((entry) => (
          <FinishedCard key={entry.id} entry={entry} now={now} onProof={onProof} {...(chainNames.get(entry.chainId) ? { chainName: chainNames.get(entry.chainId)! } : {})} />
        ))}
      </div>
    </section>
  );
}
