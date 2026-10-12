import { useState } from 'react';
import { Notice } from '../Notice';
import { reasonOf } from '../../lib/account';
import { downloadWaitlistCsv, useRemoveFromWaitlist, useSendInvite, useSetInvited, useWaitlist, type WaitlistEntry, type WaitlistFilter } from '../../lib/waitlist-admin';

const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

function Row({ entry, canEmail }: { entry: WaitlistEntry; canEmail: boolean }) {
  const setInvited = useSetInvited();
  const remove = useRemoveFromWaitlist();
  const sendInvite = useSendInvite();
  const [confirming, setConfirming] = useState<'remove' | 'send' | null>(null);
  const invited = entry.status === 'invited';
  const error = sendInvite.error ?? setInvited.error ?? remove.error;
  const sentUntil = sendInvite.data?.expiresAt;
  return (
    <li className="admin-code">
      <div className="admin-code__main">
        <b className="mono" style={{ overflowWrap: 'anywhere' }}>
          {entry.email}
        </b>
        <small>
          Joined {day(entry.createdAt)}
          {invited && entry.invitedAt ? ` · invited ${day(entry.invitedAt)}` : ''}
        </small>
      </div>
      <span className={`pill ${invited ? 'live' : 'idle'}`}>{invited ? 'invited' : 'waiting'}</span>
      <div className="admin-code__actions">
        {confirming === 'remove' ? (
          <>
            <span className="admin-code__ask">Remove for good?</span>
            <button type="button" className="danger" disabled={remove.isPending} onClick={() => remove.mutate(entry.id)}>
              Remove
            </button>
            <button type="button" onClick={() => setConfirming(null)}>
              Keep
            </button>
          </>
        ) : confirming === 'send' ? (
          <>
            <span className="admin-code__ask">Email them an invite code?</span>
            <button
              type="button"
              className="primary"
              disabled={sendInvite.isPending}
              onClick={() => sendInvite.mutate(entry.id, { onSettled: () => setConfirming(null) })}
            >
              {sendInvite.isPending ? 'Sending…' : 'Send'}
            </button>
            <button type="button" disabled={sendInvite.isPending} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {!invited && canEmail && (
              <button type="button" className="primary" onClick={() => setConfirming('send')}>
                Approve & send invite
              </button>
            )}
            <button type="button" disabled={setInvited.isPending} onClick={() => setInvited.mutate({ id: entry.id, invited: !invited })}>
              {invited ? 'Undo invited' : 'Mark invited'}
            </button>
            <button type="button" onClick={() => setConfirming('remove')}>
              Remove
            </button>
          </>
        )}
      </div>
      {sentUntil && invited && (
        <Notice tone="ok" compact className="admin-code__error">
          Invite sent. The code works until {day(sentUntil)}; revoke it under Invite codes to stop it sooner.
        </Notice>
      )}
      {error && (
        <Notice tone="error" compact className="admin-code__error">
          {reasonOf(error, 'That did not work. Try again.')}
        </Notice>
      )}
    </li>
  );
}

/** The landing page waitlist: who left an email, newest first. */
export function WaitlistPanel() {
  const [filter, setFilter] = useState<WaitlistFilter>('all');
  const list = useWaitlist(filter);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  const counts = list.data?.counts;
  const rows = list.data?.entries ?? [];

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadWaitlistCsv();
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(false);
    }
  };

  const copyWaiting = () => {
    const emails = rows.filter((r) => r.status === 'waiting').map((r) => r.email);
    void navigator.clipboard?.writeText(emails.join('\n')).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <section className="admin-card" aria-labelledby="admin-waitlist">
      <div className="admin-card__head">
        <h2 id="admin-waitlist">Waitlist</h2>
        {counts && (
          <small>
            {counts.waiting} waiting · {counts.invited} invited
          </small>
        )}
      </div>
      <p className="admin__sub">
        {list.data?.inviteEmail
          ? 'People who left their email on the landing page. Approve someone to email them an invite code (valid 14 days, revocable under Invite codes).'
          : 'People who left their email on the landing page. Make an invite code for someone, send it to them, then mark them invited here.'}
      </p>
      <div className="admin-fields">
        <label className="admin-field">
          <span>Show</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as WaitlistFilter)} aria-label="Show">
            <option value="all">Everyone</option>
            <option value="waiting">Still waiting</option>
            <option value="invited">Invited</option>
          </select>
        </label>
      </div>
      <div className="admin-new__actions">
        <button type="button" disabled={exporting || rows.length === 0} onClick={() => void exportCsv()}>
          {exporting ? 'Preparing…' : 'Download CSV'}
        </button>
        <button type="button" disabled={!rows.some((r) => r.status === 'waiting')} onClick={copyWaiting}>
          {copied ? 'Copied' : 'Copy waiting emails'}
        </button>
      </div>
      {exportError != null && <Notice tone="error">{reasonOf(exportError, 'Could not export the list. Try again.')}</Notice>}
      {list.isLoading ? (
        <div className="skeleton" style={{ height: 60 }} aria-hidden />
      ) : list.isError ? (
        <Notice tone="error">{reasonOf(list.error, 'Could not load the waitlist.')}</Notice>
      ) : rows.length === 0 ? (
        <p className="empty-state">{filter === 'all' ? 'Nobody has joined yet.' : 'Nobody here.'}</p>
      ) : (
        <ul className="admin-codes" aria-label="Waitlist, newest first">
          {rows.map((r) => (
            <Row key={r.id} entry={r} canEmail={!!list.data?.inviteEmail} />
          ))}
        </ul>
      )}
    </section>
  );
}
