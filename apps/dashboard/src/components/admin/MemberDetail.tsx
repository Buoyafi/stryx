import { useState } from 'react';
import { Notice } from '../Notice';
import { StepUpPrompt } from '../StepUpPrompt';
import { errorCode, reasonOf } from '../../lib/account';
import { useNow } from '../../lib/useNow';
import { count, rate, shortAddress, useMemberDetail, useSetMemberStatus, type MemberDetail as Detail } from '../../lib/admin-overview';
import { MintRow } from './ActivityPanel';
import { AuditRow } from './AuditPanel';

const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

function SuspendControls({ detail }: { detail: Detail }) {
  const change = useSetMemberStatus(detail.member.id);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const suspended = detail.member.status === 'SUSPENDED';
  const isAdmin = detail.member.role === 'ADMIN';

  const run = () =>
    change.mutate(
      { suspend: !suspended, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: (res) => {
          setAsking(false);
          setReason('');
          setDone(suspended ? 'Reactivated. They can sign in again, and their schedules can fire.' : `Suspended. ${res.sessionsEnded ?? 0} session${res.sessionsEnded === 1 ? '' : 's'} ended.`);
        },
        onError: (err) => {
          if (errorCode(err) === 'step_up_required') setNeedsStepUp(true);
        },
      },
    );

  if (isAdmin) return <p className="ov-note">Admins cannot be suspended here. Make the account a member first (npm run operator:revoke).</p>;

  return (
    <div className="member-actions">
      {asking ? (
        <>
          <p className="ov-note">
            {suspended
              ? 'Reactivate this account? They can sign in again, and the emergency stop set when they were suspended is lifted, so their scheduled mints can fire.'
              : 'Suspend this account? They are signed out on every device, cannot sign in, and their scheduled mints are stopped. Their wallets and history are kept.'}
          </p>
          {!suspended && (
            <label className="admin-field">
              <span>Reason (optional, on the audit log)</span>
              <input value={reason} maxLength={200} placeholder="e.g. abuse report" onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
          <div className="profile-actions">
            <button type="button" className={suspended ? 'primary' : 'danger'} disabled={change.isPending} onClick={run}>
              {change.isPending ? 'Saving…' : suspended ? 'Reactivate' : 'Suspend'}
            </button>
            <button type="button" disabled={change.isPending} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="profile-actions">
          <button type="button" className={suspended ? 'primary' : undefined} onClick={() => { setAsking(true); setDone(null); }}>
            {suspended ? 'Reactivate account' : 'Suspend account'}
          </button>
        </div>
      )}
      {done && (
        <span role="status" className="profile-saved">
          {done}
        </span>
      )}
      {change.isError && errorCode(change.error) !== 'step_up_required' && <Notice tone="error">{reasonOf(change.error, 'Could not change the account. Try again.')}</Notice>}
      {needsStepUp && (
        <StepUpPrompt
          reason={suspended ? 'Reactivating an account is an admin action.' : 'Suspending an account is an admin action.'}
          onCancel={() => setNeedsStepUp(false)}
          onGranted={() => {
            setNeedsStepUp(false);
            run();
          }}
        />
      )}
    </div>
  );
}

function Body({ detail }: { detail: Detail }) {
  const now = useNow(30_000);
  const m = detail.member;
  return (
    <>
      <section className="admin-card" aria-labelledby="member-title">
        <div className="admin-card__head">
          <h2 id="member-title">{m.displayName ?? 'No name yet'}</h2>
          {m.role === 'ADMIN' && <span className="pill live">admin</span>}
          {m.status === 'SUSPENDED' && <span className="pill fail">suspended</span>}
        </div>
        <dl className="profile-facts">
          <div>
            <dt>Account</dt>
            <dd className="mono" title={m.id}>
              {m.id.slice(0, 8)}…
            </dd>
          </div>
          <div>
            <dt>Joined</dt>
            <dd>{day(m.createdAt)}</dd>
          </div>
          {(m.discordHandle || m.xHandle) && (
            <div>
              <dt>Socials</dt>
              <dd>{[m.discordHandle && `Discord @${m.discordHandle}`, m.xHandle && `X @${m.xHandle}`].filter(Boolean).join(' · ')}</dd>
            </div>
          )}
        </dl>
        <SuspendControls detail={detail} />
      </section>

      <div className="ov-tiles" aria-label="Their mints">
        <div className="ov-tile">
          <span className="ov-tile__label">Mints</span>
          <b className="ov-tile__value">{count(detail.mints.settled)}</b>
          <span className="ov-tile__sub">{detail.mints.pending > 0 ? `${count(detail.mints.pending)} still pending` : `${count(detail.mints.confirmed)} confirmed`}</span>
        </div>
        <div className="ov-tile">
          <span className="ov-tile__label">Success rate</span>
          <b className="ov-tile__value">{detail.mints.successRate === null ? 'No mints' : rate(detail.mints.successRate)}</b>
          <span className="ov-tile__sub">{count(detail.mints.settled - detail.mints.confirmed)} failed</span>
        </div>
        <div className="ov-tile">
          <span className="ov-tile__label">Bot wallets</span>
          <b className="ov-tile__value">{count(detail.wallets.length)}</b>
          <span className="ov-tile__sub">{count(detail.wallets.filter((w) => w.status === 'ACTIVE').length)} active</span>
        </div>
      </div>

      <div className="ov-grid">
        <section className="admin-card" aria-labelledby="member-signin">
          <h2 id="member-signin">Signs in with</h2>
          {detail.signInWallets.length === 0 ? (
            <p className="ov-empty">No sign-in wallet (API token or password only).</p>
          ) : (
            <ul className="ov-list ov-list--tight">
              {detail.signInWallets.map((w) => (
                <li key={w.address}>
                  <span className="mono" title={w.address}>
                    {shortAddress(w.address)}
                  </span>
                  <small>{w.lastUsedAt ? `last used ${day(w.lastUsedAt)}` : `added ${day(w.addedAt)}`}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="admin-card" aria-labelledby="member-wallets">
          <h2 id="member-wallets">Bot wallets</h2>
          {detail.wallets.length === 0 ? (
            <p className="ov-empty">None yet.</p>
          ) : (
            <ul className="ov-list ov-list--tight">
              {detail.wallets.map((w) => (
                <li key={w.id}>
                  <span>
                    {w.label ?? 'No label'}
                    <small className="mono" title={w.address}>
                      {shortAddress(w.address)} · {w.tier.toLowerCase()} · {w.origin.toLowerCase()}
                    </small>
                  </span>
                  <span className={`pill ${w.status === 'ACTIVE' ? 'idle' : 'pending'}`}>{w.status.toLowerCase()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="admin-card" aria-labelledby="member-mints">
        <h2 id="member-mints">Latest mints</h2>
        {detail.recentMints.length === 0 ? (
          <p className="ov-empty">No mints yet.</p>
        ) : (
          <ul className="ov-rows" aria-label="Their mints, newest first">
            {detail.recentMints.map((r) => (
              <MintRow key={r.id} m={r} now={now} />
            ))}
          </ul>
        )}
      </section>

      <section className="admin-card" aria-labelledby="member-audit">
        <h2 id="member-audit">On the record</h2>
        <p className="ov-note">What they did, and what admins did to their account, newest first.</p>
        {detail.audit.length === 0 ? (
          <p className="ov-empty">Nothing recorded yet.</p>
        ) : (
          <ul className="ov-rows" aria-label="Their audit entries, newest first">
            {detail.audit.map((e) => (
              <AuditRow key={e.id} e={e} now={now} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * One member's page: profile, sign-in and bot wallets (never keys), mints, their audit trail, and
 * suspending or reactivating them.
 */
export function MemberDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useMemberDetail(id);
  const [confirming, setConfirming] = useState(false);
  const needsConfirm = detail.isError && errorCode(detail.error) === 'step_up_required';

  return (
    <div className="admin-panel">
      <div>
        <button type="button" className="welcome__link" onClick={onBack}>
          ← All members
        </button>
      </div>
      {detail.isLoading && <div className="skeleton" style={{ height: 160 }} aria-hidden />}
      {needsConfirm && (
        <section className="admin-card" aria-labelledby="member-locked">
          <h2 id="member-locked">Confirm it’s you</h2>
          <p className="ov-note">A member’s page shows their wallets, mints and history. Confirm it is you to open it; opening it is recorded on the audit log.</p>
          <div className="profile-actions">
            <button type="button" className="primary" onClick={() => setConfirming(true)}>
              Confirm and open
            </button>
          </div>
        </section>
      )}
      {detail.isError && !needsConfirm && <Notice tone="error">{reasonOf(detail.error, 'Could not load this member.')}</Notice>}
      {detail.data && <Body detail={detail.data} />}
      {confirming && (
        <StepUpPrompt
          reason="You are opening a member’s records."
          onCancel={() => setConfirming(false)}
          onGranted={() => {
            setConfirming(false);
            void detail.refetch();
          }}
        />
      )}
    </div>
  );
}
