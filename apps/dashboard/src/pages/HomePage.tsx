import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';
import { ApiError } from '../lib/api';
import { ChainMarquee } from '../components/ChainMarquee';
import { CollectionThumb } from '../components/CollectionThumb';
import { SegmentedControl } from '../components/SegmentedControl';
import { useNow } from '../lib/useNow';
import {
  STATUS_LABEL,
  WINDOW_OPTIONS,
  chainLabel,
  floorMultiple,
  formatCount,
  formatPrice,
  formatSupply,
  mintedPercent,
  shortDateTime,
  startsIn,
  timeAgo,
  useDropsFeed,
  type FeedWindow,
  type PastMint,
  type UpcomingDrop,
} from '../lib/home-feed';
import { Notice } from '../components/Notice';
import { WelcomeCard } from '../components/WelcomeCard';
import { MemberCard } from '../components/MemberCard';
import { clearJustJoined, isJustJoined } from '../lib/account';
import { useViewer } from '../lib/viewer';
import { NavLock } from '../components/Sidebar';

function ChainBadge({ chain, chainId }: { chain: string; chainId: number | null }) {
  if (chainId === null) return <span className="home-chain">{chainLabel(chain)}</span>;
  const view = viewForChainId(chainId, chainLabel(chain));
  return (
    <span className="home-chain">
      <ChainIcon chain={view} interactive={false} size="sm" />
      <span>{view.name}</span>
    </span>
  );
}

function SupplyBar({ totalSupply, maxSupply, hideUnknown = false }: { totalSupply: number | null; maxSupply: number | null; hideUnknown?: boolean }) {
  const pct = mintedPercent(totalSupply, maxSupply);
  if (hideUnknown && totalSupply === null && maxSupply === null) return null;
  return (
    <div className="home-supply">
      <span className="mono">{formatSupply(totalSupply, maxSupply)}</span>
      {pct !== null && (
        <span className="home-supply__bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Minted">
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  );
}

/** "Open in Mint" only for chains this platform runs; everything links out to OpenSea. */
function DropActions({ drop }: { drop: { chainId: number | null; openSeaUrl: string } }) {
  const visitor = useViewer().kind === 'visitor';
  return (
    <div className="home-card__actions">
      {visitor && drop.chainId !== null && (
        <button type="button" className="home-btn home-btn--locked" onClick={() => window.dispatchEvent(new Event('stryx:ask-code'))} title="Minting needs an invite code">
          <NavLock inline />
          Code needed
        </button>
      )}
      {!visitor && drop.chainId !== null && (
        <Link className="home-btn home-btn--primary" to={`/mint?collection=${encodeURIComponent(drop.openSeaUrl)}`}>
          Open in Mint
        </Link>
      )}
      <a className="home-btn" href={drop.openSeaUrl} target="_blank" rel="noopener noreferrer">
        OpenSea
      </a>
    </div>
  );
}

function UpcomingCard({ drop, now }: { drop: UpcomingDrop; now: number }) {
  const stage = drop.stage;
  return (
    <article className="home-card">
      <div className="home-card__head">
        <CollectionThumb image={drop.imageUrl ? { kind: 'external', url: drop.imageUrl } : null} name={drop.name} contract={drop.contractAddress} size={48} />
        <div className="home-card__title">
          <h3 title={drop.name}>{drop.name}</h3>
          <ChainBadge chain={drop.chain} chainId={drop.chainId} />
        </div>
        {drop.isMinting ? <span className="pill live">Live</span> : stage ? <span className="pill idle">{startsIn(stage.startTime, now)}</span> : null}
      </div>
      <dl className="home-facts">
        <div>
          <dt>{drop.isMinting ? 'Stage' : 'Next stage'}</dt>
          <dd>{stage ? stage.label : '-'}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd className="mono">{formatPrice(stage?.price ?? null)}</dd>
        </div>
        <div>
          <dt>{drop.isMinting ? 'Ends' : 'Starts'}</dt>
          <dd>{stage ? shortDateTime(drop.isMinting ? stage.endTime : stage.startTime) : '-'}</dd>
        </div>
        <div>
          <dt>Per wallet</dt>
          <dd className="mono">{stage?.maxPerWallet ?? '-'}</dd>
        </div>
      </dl>
      <SupplyBar totalSupply={drop.totalSupply} maxSupply={drop.maxSupply} hideUnknown />
      <DropActions drop={drop} />
    </article>
  );
}

function PastMintRow({ mint, now }: { mint: PastMint; now: number }) {
  const multiple = floorMultiple(mint.mintPrice, mint.floor);
  const statusClass = mint.status === 'minting' ? 'live' : mint.status === 'sold_out' ? 'done' : 'idle';
  return (
    <tr>
      <td className="home-table__collection">
        <a href={mint.openSeaUrl} target="_blank" rel="noopener noreferrer" className="home-table__link">
          <CollectionThumb image={mint.imageUrl ? { kind: 'external', url: mint.imageUrl } : null} name={mint.name} contract={mint.contractAddress} size={36} />
          <span className="home-table__name">
            <strong title={mint.name}>{mint.name}</strong>
            <ChainBadge chain={mint.chain} chainId={mint.chainId} />
          </span>
        </a>
      </td>
      <td data-label="Minted" title={shortDateTime(mint.mintedAt)}>
        {timeAgo(mint.mintedAt, now)}
      </td>
      <td data-label="Mint price" className="mono">
        {formatPrice(mint.mintPrice)}
      </td>
      <td data-label="Floor" className="mono">
        {formatPrice(mint.floor)}
        {multiple && <span className="home-multiple"> {multiple}</span>}
      </td>
      <td data-label="Supply">
        <SupplyBar totalSupply={mint.totalSupply} maxSupply={mint.maxSupply} />
      </td>
      <td data-label="Owners" className="mono">
        {formatCount(mint.owners)}
      </td>
      <td data-label="Status">
        <span className={`pill ${statusClass}`}>{STATUS_LABEL[mint.status]}</span>
      </td>
    </tr>
  );
}

function feedErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string } | null;
    if (body?.message) return body.message;
    return `Could not load drops (HTTP ${err.status}).`;
  }
  return 'Could not reach the API.';
}

function CardSkeletons({ count }: { count: number }) {
  return (
    <div className="home-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="home-card">
          <div className="skeleton" style={{ width: '60%' }} />
          <div className="skeleton" style={{ width: '90%', height: 40 }} />
          <div className="skeleton" style={{ width: '40%' }} />
        </div>
      ))}
    </div>
  );
}

/**
 * The landing section: OpenSea's live and upcoming drops, and what minted in the last 7 or 30 days
 * with floor, supply and owners.
 */
export function HomePage() {
  const [range, setRange] = useState<FeedWindow>('7d');
  const feed = useDropsFeed(range);
  const now = useNow(30_000);
  const data = feed.data;
  const live = data?.upcoming.filter((d) => d.isMinting) ?? [];
  const upcoming = data?.upcoming.filter((d) => !d.isMinting) ?? [];
  const viewer = useViewer();
  const [joined] = useState(() => viewer.kind === 'member' && isJustJoined());
  // Shown once: cleared after it has been shown, not while reading it.
  useEffect(() => {
    if (joined) clearJustJoined();
  }, [joined]);

  return (
    <div className="home">
      <header className="home__head">
        <div>
          <h1>Home</h1>
          <p className="home__sub">Drops on OpenSea: what is live, what opens next, and how recent mints are trading.</p>
        </div>
        {data && <span className="home__updated">Updated {timeAgo(data.fetchedAt, now)}</span>}
      </header>

      {viewer.kind === 'visitor' && <WelcomeCard onSignedIn={viewer.onSignedIn} />}
      {viewer.kind === 'member' && <MemberCard justJoined={joined} />}

      <ChainMarquee />

      {feed.isError && !data && (
        <Notice
          tone="error"
          className="home__notice"
          action={
            <button type="button" onClick={() => void feed.refetch()}>
              Try again
            </button>
          }
        >
          {feedErrorMessage(feed.error)}
        </Notice>
      )}
      {data?.warning && (
        <Notice tone="warn" className="home__notice">
          {data.warning}
        </Notice>
      )}

      {(feed.isLoading || live.length > 0) && (
        <section className="ops-section" aria-labelledby="home-live">
          <div className="ops-section__head">
            <h2 id="home-live">Live now</h2>
            {live.length > 0 && <span className="home__count">{live.length}</span>}
          </div>
          {feed.isLoading ? (
            <CardSkeletons count={3} />
          ) : (
            <div className="home-grid">
              {live.map((d) => (
                <UpcomingCard key={d.slug} drop={d} now={now} />
              ))}
            </div>
          )}
        </section>
      )}

      {data && (
        <section className="ops-section" aria-labelledby="home-upcoming">
          <div className="ops-section__head">
            <h2 id="home-upcoming">Upcoming drops</h2>
            {upcoming.length > 0 && <span className="home__count">{upcoming.length}</span>}
          </div>
          {upcoming.length === 0 ? (
            <p className="empty-state">No upcoming drops listed on OpenSea right now.</p>
          ) : (
            <div className="home-grid">
              {upcoming.map((d) => (
                <UpcomingCard key={d.slug} drop={d} now={now} />
              ))}
            </div>
          )}
        </section>
      )}

      {(data || feed.isLoading) && (
        <section className="ops-section" aria-labelledby="home-past">
          <div className="ops-section__head home__past-head">
            <h2 id="home-past">Past mints</h2>
            <SegmentedControl label="Past mints window" options={WINDOW_OPTIONS} value={range} onChange={setRange} />
          </div>
          <p className="ops-note">
            Drops that started minting in the last {range === '7d' ? '7' : '30'} days, newest first. Floor is the cheapest listing now; the multiple compares it to the mint price.
          </p>
          {!data ? (
            <div className="skeleton" style={{ height: 160 }} aria-hidden />
          ) : data.pastMints.length === 0 ? (
            <p className="empty-state">No mints in this window.</p>
          ) : (
            <div className={`home-table-wrap${feed.isFetching ? ' is-refreshing' : ''}`}>
              <table className="home-table">
                <thead>
                  <tr>
                    <th scope="col">Collection</th>
                    <th scope="col">Minted</th>
                    <th scope="col">Mint price</th>
                    <th scope="col">Floor</th>
                    <th scope="col">Supply</th>
                    <th scope="col">Owners</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pastMints.map((m) => (
                    <PastMintRow key={m.slug} mint={m} now={now} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
