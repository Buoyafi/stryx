import { useSearchParams } from 'react-router-dom';
import { Notice } from '../Notice';
import { MemberDetail } from './MemberDetail';
import { reasonOf } from '../../lib/account';
import { count, shortAddress, shortId, useMembers, type MemberRow } from '../../lib/admin-overview';

const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

function Row({ m, onOpen }: { m: MemberRow; onOpen: () => void }) {
  const wallet = m.signInAddresses[0];
  return (
    <li className="ov-row ov-row--link">
      <div className="ov-row__main">
        <b>
          <button type="button" className="ov-open" onClick={onOpen}>
            {m.displayName ?? 'No name yet'}
          </button>
        </b>
        <small>
          <span className="mono" title={m.id}>
            {shortId(m.id)}
          </span>
          {wallet && (
            <>
              {' · signs in with '}
              <span className="mono" title={m.signInAddresses.join('\n')}>
                {shortAddress(wallet)}
              </span>
              {m.signInAddresses.length > 1 ? ` +${m.signInAddresses.length - 1}` : ''}
            </>
          )}
        </small>
        <small>
          Joined {day(m.createdAt)} · {count(m.wallets)} wallet{m.wallets === 1 ? '' : 's'} · {count(m.mints)} mint{m.mints === 1 ? '' : 's'}
          {m.lastMintAt ? ` · last mint ${day(m.lastMintAt)}` : ''}
        </small>
      </div>
      <div className="ov-row__side">
        {m.role === 'ADMIN' && <span className="pill live">admin</span>}
        {m.status === 'SUSPENDED' && <span className="pill fail">suspended</span>}
      </div>
    </li>
  );
}

/** Every account, newest first, with the wallets it signs in with and what it has done. Opens one member's page (?member=). */
export function MembersPanel() {
  const [params, setParams] = useSearchParams();
  const open = params.get('member');
  const members = useMembers();
  if (open) {
    return (
      <MemberDetail
        id={open}
        onBack={() => {
          const next = new URLSearchParams(params);
          next.delete('member');
          setParams(next, { replace: true });
        }}
      />
    );
  }
  const rows = members.data?.pages.flatMap((p) => p.rows) ?? [];
  return (
    <section className="admin-card" aria-labelledby="ov-members">
      <div className="admin-card__head">
        <h2 id="ov-members">Members</h2>
        <small>Newest first</small>
      </div>
      {members.isError && rows.length === 0 && <Notice tone="error">{reasonOf(members.error, 'Could not load the members.')}</Notice>}
      {members.isLoading ? (
        <div className="skeleton" style={{ height: 120 }} aria-hidden />
      ) : rows.length === 0 && !members.isError ? (
        <p className="ov-empty">No accounts yet.</p>
      ) : (
        <ul className="ov-rows" aria-label="Members, newest first">
          {rows.map((m) => (
            <Row
              key={m.id}
              m={m}
              onOpen={() => {
                const next = new URLSearchParams(params);
                next.set('member', m.id);
                setParams(next);
              }}
            />
          ))}
        </ul>
      )}
      {members.hasNextPage && (
        <button type="button" className="ov-more" disabled={members.isFetchingNextPage} onClick={() => void members.fetchNextPage()}>
          {members.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
