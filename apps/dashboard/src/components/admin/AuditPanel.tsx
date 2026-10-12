import { useState } from 'react';
import { Notice } from '../Notice';
import { reasonOf } from '../../lib/account';
import { useNow } from '../../lib/useNow';
import { timeAgo } from '../../lib/home-feed';
import { AUDIT_CATEGORIES, actionLabel, shortId, useAuditLog, type AuditCategory, type AuditEntry } from '../../lib/admin-overview';

function who(e: AuditEntry): string {
  if (e.actorType === 'SYSTEM') return 'System';
  if (!e.actorUserId) return 'Someone not signed in';
  return e.actorName ?? `${e.actorType === 'ADMIN' ? 'Admin' : 'Member'} ${shortId(e.actorUserId)}`;
}

export function AuditRow({ e, now }: { e: AuditEntry; now: number }) {
  const ok = e.outcome === 'SUCCESS';
  return (
    <li className="ov-row">
      <div className="ov-row__main">
        <b>{actionLabel(e.action)}</b>
        <small>
          <span title={e.actorUserId ?? undefined}>{who(e)}</span>
          {e.actorType === 'ADMIN' && e.actorUserId && ' (admin)'}
          {' · '}
          <span className="mono">{e.action}</span>
        </small>
        {e.detail && (
          <small className="ov-row__detail" title={e.detail}>
            {e.detail}
          </small>
        )}
      </div>
      <div className="ov-row__side">
        <span className={`pill ${ok ? 'idle' : 'fail'}`}>{ok ? 'ok' : 'failed'}</span>
        <time dateTime={e.createdAt} title={new Date(e.createdAt).toLocaleString()}>
          {timeAgo(e.createdAt, now)}
        </time>
      </div>
    </li>
  );
}

/**
 * The audit log, newest first: sign-ins, mints, key exports, emergency stops, invite codes, role
 * changes, and admins viewing member records.
 */
export function AuditPanel() {
  const [category, setCategory] = useState<AuditCategory | ''>('');
  const log = useAuditLog(category);
  const now = useNow(30_000);
  const rows = log.data?.pages.flatMap((p) => p.rows) ?? [];
  return (
    <section className="admin-card" aria-labelledby="ov-audit">
      <div className="admin-card__head">
        <h2 id="ov-audit">Audit log</h2>
        <label className="ov-filter">
          <span className="sr-only">Show</span>
          <select value={category} onChange={(ev) => setCategory(ev.target.value as AuditCategory | '')} aria-label="Show">
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="ov-note">Every sign-in, mint, key export, emergency stop and admin action, newest first. It cannot be edited or deleted.</p>
      {log.isError && rows.length === 0 && <Notice tone="error">{reasonOf(log.error, 'Could not load the audit log.')}</Notice>}
      {log.isLoading ? (
        <div className="skeleton" style={{ height: 120 }} aria-hidden />
      ) : rows.length === 0 && !log.isError ? (
        <p className="ov-empty">Nothing recorded here yet.</p>
      ) : (
        <ul className="ov-rows" aria-label="Audit log, newest first">
          {rows.map((e) => (
            <AuditRow key={e.id} e={e} now={now} />
          ))}
        </ul>
      )}
      {log.hasNextPage && (
        <button type="button" className="ov-more" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          {log.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </button>
      )}
    </section>
  );
}
