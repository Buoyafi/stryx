import { chainById, explorerTxUrl } from '@stryx/chains';
import { Notice } from '../Notice';
import { CollectionAvatar } from '../CollectionAvatar';
import { reasonOf } from '../../lib/account';
import { useCollectionName } from '../../lib/useCollectionName';
import { useNow } from '../../lib/useNow';
import { timeAgo } from '../../lib/home-feed';
import { blockedReason } from '../../lib/server-mints';
import { SOURCE_LABEL, shortAddress, shortId, usePlatformActivity, type PlatformMint } from '../../lib/admin-overview';

const PILL: Record<string, { cls: 'live' | 'pending' | 'fail' | 'idle'; label: string }> = {
  CONFIRMED: { cls: 'live', label: 'confirmed' },
  PENDING: { cls: 'pending', label: 'pending' },
  SENDING: { cls: 'pending', label: 'sending' },
  REVERTED: { cls: 'fail', label: 'reverted' },
  BLOCKED: { cls: 'fail', label: 'refused' },
  DROPPED: { cls: 'idle', label: 'dropped' },
};

export function MintRow({ m, now }: { m: PlatformMint; now: number }) {
  const { name } = useCollectionName(m.chainId, m.contract);
  const chain = chainById(m.chainId);
  const pill = PILL[m.status] ?? { cls: 'idle' as const, label: m.status.toLowerCase() };
  const link = m.txHash && chain ? explorerTxUrl(chain, m.txHash) : undefined;
  return (
    <li className="ov-row ov-row--art">
      <CollectionAvatar chainId={m.chainId} contract={m.contract} name={name} size={36} />
      <div className="ov-row__main">
        <b title={m.contract}>{name ?? `Contract ${shortAddress(m.contract)}`}</b>
        <small>
          {chain?.name ?? `Chain ${m.chainId}`} · {m.quantity} NFT{m.quantity === 1 ? '' : 's'} · {SOURCE_LABEL[m.source] ?? m.source}
        </small>
        <small>
          <span title={m.ownerId}>{m.ownerName ?? `Member ${shortId(m.ownerId)}`}</span>
          {' · '}
          <span className="mono" title={m.walletAddress}>
            {shortAddress(m.walletAddress)}
          </span>
          {link && (
            <>
              {' · '}
              <a className="mono" href={link} target="_blank" rel="noreferrer noopener" title={m.txHash!}>
                {shortAddress(m.txHash!)}
                <span aria-hidden="true"> ↗</span>
                <span className="sr-only"> (opens the block explorer)</span>
              </a>
            </>
          )}
        </small>
        {m.status === 'BLOCKED' && <small className="ov-row__reason">{blockedReason(m.failureReason, m.failureNote)}</small>}
      </div>
      <div className="ov-row__side">
        <span className={`pill ${pill.cls}`}>{pill.label}</span>
        <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
          {timeAgo(m.createdAt, now)}
        </time>
      </div>
    </li>
  );
}

/** Every member's mints as they happen, newest first. Refreshes every 10 seconds. */
export function ActivityPanel() {
  const feed = usePlatformActivity();
  const now = useNow(30_000);
  const rows = feed.data?.pages.flatMap((p) => p.rows) ?? [];
  return (
    <section className="admin-card" aria-labelledby="ov-activity">
      <div className="admin-card__head">
        <h2 id="ov-activity">Live activity</h2>
        <small>Every member’s mints · refreshes every 10 seconds</small>
      </div>
      {feed.isError && rows.length === 0 && <Notice tone="error">{reasonOf(feed.error, 'Could not load the activity.')}</Notice>}
      {feed.isLoading ? (
        <div className="skeleton" style={{ height: 120 }} aria-hidden />
      ) : rows.length === 0 && !feed.isError ? (
        <p className="ov-empty">No mints yet.</p>
      ) : (
        <ul className="ov-rows" aria-label="Mints, newest first">
          {rows.map((m) => (
            <MintRow key={m.id} m={m} now={now} />
          ))}
        </ul>
      )}
      {feed.hasNextPage && (
        <button type="button" className="ov-more" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
          {feed.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </button>
      )}
    </section>
  );
}
