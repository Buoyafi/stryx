import { useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { reasonOf } from '../lib/account';
import { useAccessCodes, useCreateAccessCode, useRevokeAccessCode, type AccessCodeRow } from '../lib/access-codes';
import { Notice } from '../components/Notice';
import { OverviewPanel } from '../components/admin/OverviewPanel';
import { ActivityPanel } from '../components/admin/ActivityPanel';
import { MembersPanel } from '../components/admin/MembersPanel';
import { AuditPanel } from '../components/admin/AuditPanel';
import { WaitlistPanel } from '../components/admin/WaitlistPanel';

const EXPIRY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Never' },
  { value: '7', label: 'In 7 days' },
  { value: '30', label: 'In 30 days' },
  { value: '90', label: 'In 90 days' },
];

const STATUS: Record<AccessCodeRow['status'], { cls: string; label: string }> = {
  unused: { cls: 'live', label: 'unused' },
  used: { cls: 'idle', label: 'used' },
  revoked: { cls: 'fail', label: 'revoked' },
  expired: { cls: 'pending', label: 'expired' },
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

function NewCode({ code, onDone }: { code: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="admin-new" role="status">
      <span className="admin-new__label">New invite code</span>
      <code className="admin-new__code">{code}</code>
      <p className="admin-new__note">Copy it now: it is shown this once and never stored.</p>
      <div className="admin-new__actions">
        <button
          type="button"
          className="primary"
          onClick={() => {
            navigator.clipboard?.writeText(code).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy code'}
        </button>
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function CodeRow({ row }: { row: AccessCodeRow }) {
  const revoke = useRevokeAccessCode();
  const [confirming, setConfirming] = useState(false);
  const pill = STATUS[row.status];
  return (
    <li className="admin-code">
      <div className="admin-code__main">
        <b>{row.label || 'No label'}</b>
        <small>
          Made {day(row.createdAt)}
          {row.expiresAt && row.status === 'unused' ? ` · expires ${day(row.expiresAt)}` : ''}
          {row.boundAddress ? ` · only for ${short(row.boundAddress)}` : ''}
        </small>
        {row.status === 'used' && row.redeemedByAddress && (
          <small className="mono" title={row.redeemedByAddress}>
            Used by {short(row.redeemedByAddress)}
            {row.redeemedAt ? ` on ${day(row.redeemedAt)}` : ''}
          </small>
        )}
      </div>
      <span className={`pill ${pill.cls}`}>{pill.label}</span>
      {row.status === 'unused' && (
        <div className="admin-code__actions">
          {confirming ? (
            <>
              <span className="admin-code__ask">Revoke this code?</span>
              <button type="button" className="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(row.id)}>
                Revoke
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}>
              Revoke
            </button>
          )}
        </div>
      )}
      {revoke.isError && (
        <Notice tone="error" compact className="admin-code__error">
          {reasonOf(revoke.error, 'Could not revoke. Try again.')}
        </Notice>
      )}
    </li>
  );
}

/** Invite codes: make one per person, hand it over, see who used it, revoke one that has not been used. */
function InviteCodesPanel() {
  const codes = useAccessCodes();
  const create = useCreateAccessCode();
  const [label, setLabel] = useState('');
  const [expires, setExpires] = useState('30');
  const [bound, setBound] = useState('');
  const [made, setMade] = useState<string | null>(null);

  const boundBad = bound.trim() !== '' && !/^0x[0-9a-fA-F]{40}$/.test(bound.trim());
  const off = codes.error instanceof ApiError && codes.error.status === 404;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (boundBad) return;
    setMade(null);
    create.mutate(
      {
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(expires ? { expiresInDays: Number(expires) } : {}),
        ...(bound.trim() ? { boundAddress: bound.trim() } : {}),
      },
      {
        onSuccess: (res) => {
          setMade(res.code);
          setLabel('');
          setBound('');
        },
      },
    );
  };

  const rows = codes.data?.codes ?? [];
  const unused = rows.filter((r) => r.status === 'unused').length;

  return (
    <>
      <p className="admin__sub">One code per person, used once. Whoever uses it signs in with their wallet and gets an account.</p>
      {off && <Notice tone="warn">Invite codes are off on this server. Set APP_ORIGIN and ACCESS_CODE_SECRET to turn them on.</Notice>}

      {!off && (
        <form className="admin-card" onSubmit={submit} noValidate aria-labelledby="admin-make">
          <h2 id="admin-make">Make a code</h2>
          <div className="admin-fields">
            <label className="admin-field">
              <span>Who it is for (optional)</span>
              <input id="code-label" value={label} maxLength={80} placeholder="e.g. @name from the waitlist" onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="admin-field">
              <span>Expires</span>
              <select id="code-expiry" value={expires} onChange={(e) => setExpires(e.target.value)}>
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-field">
              <span>Only for this wallet (optional)</span>
              <input id="code-wallet" className="mono" value={bound} placeholder="0x…" aria-invalid={boundBad || undefined} onChange={(e) => setBound(e.target.value)} />
              {boundBad && <small className="admin-field__bad">That is not a wallet address.</small>}
            </label>
          </div>
          {create.isError && <Notice tone="error">{reasonOf(create.error, 'Could not make a code. Try again.')}</Notice>}
          <div>
            <button type="submit" className="primary" disabled={create.isPending || boundBad}>
              {create.isPending ? 'Making…' : 'Make a code'}
            </button>
          </div>
          {made && <NewCode code={made} onDone={() => setMade(null)} />}
        </form>
      )}

      {!off && (
        <section className="admin-card" aria-labelledby="admin-codes">
          <div className="admin-card__head">
            <h2 id="admin-codes">Codes</h2>
            {rows.length > 0 && (
              <small>
                {unused} unused of {rows.length}
              </small>
            )}
          </div>
          {codes.isLoading ? (
            <div className="skeleton" style={{ height: 60 }} aria-hidden />
          ) : codes.isError ? (
            <Notice tone="error">{reasonOf(codes.error, 'Could not load the codes.')}</Notice>
          ) : rows.length === 0 ? (
            <p className="empty-state">No codes yet. Make one above.</p>
          ) : (
            <ul className="admin-codes">
              {rows.map((r) => (
                <CodeRow key={r.id} row={r} />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview', Panel: OverviewPanel },
  { id: 'activity', label: 'Live activity', Panel: ActivityPanel },
  { id: 'members', label: 'Members', Panel: MembersPanel },
  { id: 'audit', label: 'Audit log', Panel: AuditPanel },
  { id: 'codes', label: 'Invite codes', Panel: InviteCodesPanel },
  { id: 'waitlist', label: 'Waitlist', Panel: WaitlistPanel },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Admin only: the platform at a glance, every member's mints, the member list, the audit log, invite codes and the waitlist. */
export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === asked) ? (asked as TabId) : 'overview';
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (id: TabId) => setParams(id === 'overview' ? {} : { tab: id }, { replace: true });

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const last = TABS.length - 1;
    const next = e.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (next === null) return;
    e.preventDefault();
    select(TABS[next]!.id);
    refs.current[next]?.focus();
  };

  const Active = TABS.find((t) => t.id === tab)!.Panel;
  return (
    <div className="admin admin--wide">
      <header>
        <h1>Admin</h1>
        <p className="admin__sub">The whole platform: members, mints, what failed and why, and everything on the record.</p>
      </header>
      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`admin-tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls={`admin-panel-${t.id}`}
            tabIndex={t.id === tab ? 0 : -1}
            className={`admin-tab${t.id === tab ? ' is-active' : ''}`}
            onClick={() => select(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="admin-panel" role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-tab-${tab}`}>
        <Active />
      </div>
    </div>
  );
}
