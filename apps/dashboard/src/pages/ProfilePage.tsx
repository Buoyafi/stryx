import { useEffect, useState } from 'react';
import { Notice } from '../components/Notice';
import { ApiError, apiRequest } from '../lib/api';
import { mintFeedStore } from '../lib/mint-feed-store';
import { clearRecentCollections, setRecentCollectionsAccount } from '../lib/recent-collections-store';
import {
  DISPLAY_NAME_MAX,
  displayNameProblem,
  handleProblem,
  normaliseDisplayName,
  normaliseHandle,
  useMe,
  useSaveProfile,
} from '../lib/profile';

function saveError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string } | null;
    return body?.message ?? `Could not save (HTTP ${err.status}).`;
  }
  return 'Could not reach the API.';
}

function HandleField(props: {
  id: string;
  label: string;
  kind: 'discord' | 'x';
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const problem = handleProblem(props.kind, props.value);
  return (
    <div className="profile-field">
      <label htmlFor={props.id} className="profile-field__label">
        {props.label}
      </label>
      <div className={`profile-field__box${problem ? ' is-bad' : ''}`}>
        <span aria-hidden="true">@</span>
        <input
          id={props.id}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={props.value}
          placeholder={props.placeholder}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${props.id}-problem` : undefined}
          onChange={(e) => props.onChange(e.target.value)}
        />
      </div>
      {problem && (
        <span id={`${props.id}-problem`} className="profile-field__problem">
          {problem}
        </span>
      )}
    </div>
  );
}

/** "Sign out everywhere": ends this account's sessions on every device, this one included. */
function SignOutEverywhere({
  viaToken,
  onDone = () => window.location.assign('/home'),
}: {
  viaToken: boolean;
  onDone?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ended } = await apiRequest<{ ended: number }>('/auth/logout-everywhere', {
        method: 'POST',
      });
      if (viaToken) {
        setResult(
          `Ended ${ended} wallet session${ended === 1 ? '' : 's'}. The API token you are using keeps working.`,
        );
        setAsking(false);
        return;
      }
      // This browser's own mint record goes too, as with a normal sign-out.
      mintFeedStore.clear();
      mintFeedStore.setAccount(null);
      clearRecentCollections();
      setRecentCollectionsAccount(null);
      onDone();
    } catch (err) {
      setError(saveError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="profile-signout">
      <p className="profile-note">
        Lost a phone, or signed in on a computer that is not yours? End every session this account
        has, on every device, this one included.
      </p>
      {asking ? (
        <div className="profile-actions">
          <span className="profile-signout__ask">Sign out on every device?</span>
          <button type="button" className="danger" disabled={busy} onClick={() => void go()}>
            {busy ? 'Signing out…' : 'Sign out everywhere'}
          </button>
          <button type="button" disabled={busy} onClick={() => setAsking(false)}>
            Keep me signed in
          </button>
        </div>
      ) : (
        <div className="profile-actions">
          <button
            type="button"
            onClick={() => {
              setAsking(true);
              setResult(null);
            }}
          >
            Sign out everywhere
          </button>
        </div>
      )}
      {result && (
        <span role="status" className="profile-saved">
          {result}
        </span>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

/** The signed-in account: optional Discord and X handles, and where subscriptions will live. */
export function ProfilePage() {
  const me = useMe();
  const save = useSaveProfile();
  const [name, setName] = useState('');
  const [discord, setDiscord] = useState('');
  const [x, setX] = useState('');
  const [saved, setSaved] = useState(false);

  // Fill the boxes once the account loads (and again after a save returns the stored values).
  useEffect(() => {
    if (!me.data) return;
    setName(me.data.displayName ?? '');
    setDiscord(me.data.discordHandle ?? '');
    setX(me.data.xHandle ?? '');
  }, [me.data]);

  const data = me.data;
  const nameChanged = !!data && normaliseDisplayName(name) !== (data.displayName ?? '');
  const changed =
    !!data &&
    (nameChanged ||
      normaliseHandle('discord', discord) !== (data.discordHandle ?? '') ||
      normaliseHandle('x', x) !== (data.xHandle ?? ''));
  const nameProblem = displayNameProblem(name);
  const invalid = !!nameProblem || !!handleProblem('discord', discord) || !!handleProblem('x', x);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!changed || invalid) return;
    setSaved(false);
    // The name only when it changed, so an API from before names existed still saves handles.
    save.mutate(
      { ...(nameChanged ? { displayName: name } : {}), discordHandle: discord, xHandle: x },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <div className="profile">
      <header className="profile__head">
        <h1>Profile</h1>
        <p className="profile__sub">
          Your account, your name and handles.
        </p>
      </header>

      {me.isError && (
        <Notice tone="error">Could not load your account. Refresh to try again.</Notice>
      )}

      <section className="profile-card" aria-labelledby="profile-account">
        <div className="profile-card__head">
          <h2 id="profile-account">Account</h2>
          {data && (
            <span className={`pill ${data.role === 'ADMIN' ? 'live' : 'idle'}`}>
              {data.role === 'ADMIN' ? 'Admin' : 'Member'}
            </span>
          )}
        </div>
        {me.isLoading ? (
          <div className="skeleton" style={{ height: 40 }} aria-hidden />
        ) : data ? (
          <dl className="profile-facts">
            <div>
              <dt>Status</dt>
              <dd>{data.status === 'ACTIVE' ? 'Active' : 'Suspended'}</dd>
            </div>
            <div>
              <dt>Signed in with</dt>
              <dd
                className={data.signInAddresses?.length ? 'mono' : undefined}
                title={data.signInAddresses?.[0]}
              >
                {data.signInAddresses?.length
                  ? `${data.signInAddresses[0]!.slice(0, 6)}…${data.signInAddresses[0]!.slice(-4)}`
                  : data.signedInWith === 'token'
                    ? 'API token'
                    : 'Email and password'}
              </dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>
                {new Date(data.createdAt).toLocaleDateString([], {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </dd>
            </div>
          </dl>
        ) : null}
        {data && <SignOutEverywhere viaToken={data.signedInWith === 'token'} />}
      </section>

      <form className="profile-card" aria-labelledby="profile-handles" onSubmit={submit} noValidate>
        <div className="profile-card__head">
          <h2 id="profile-handles">Name and socials</h2>
          <small>Optional</small>
        </div>
        <div className="profile-fields">
          <div className="profile-field">
            <label htmlFor="display-name" className="profile-field__label">
              Name
            </label>
            <div className={`profile-field__box${nameProblem ? ' is-bad' : ''}`}>
              <input
                id="display-name"
                autoComplete="nickname"
                value={name}
                maxLength={DISPLAY_NAME_MAX + 8}
                placeholder="What we greet you by"
                aria-invalid={nameProblem ? true : undefined}
                aria-describedby={nameProblem ? 'display-name-problem' : undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
              />
            </div>
            {nameProblem && (
              <span id="display-name-problem" className="profile-field__problem">
                {nameProblem}
              </span>
            )}
          </div>
          <HandleField
            id="discord-handle"
            label="Discord"
            kind="discord"
            value={discord}
            onChange={(v) => {
              setDiscord(v);
              setSaved(false);
            }}
            placeholder="username"
          />
          <HandleField
            id="x-handle"
            label="X"
            kind="x"
            value={x}
            onChange={(v) => {
              setX(v);
              setSaved(false);
            }}
            placeholder="handle"
          />
        </div>
        {save.isError && <Notice tone="error">{saveError(save.error)}</Notice>}
        <div className="profile-actions">
          <button
            type="submit"
            className="primary"
            disabled={!data || !changed || invalid || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {saved && !changed && (
            <span role="status" className="profile-saved">
              Saved
            </span>
          )}
        </div>
      </form>

      <section className="profile-card profile-card--quiet" aria-labelledby="profile-plan">
        <div className="profile-card__head">
          <h2 id="profile-plan">Subscription</h2>
          <span className="pill idle">Coming later</span>
        </div>
        <p className="profile-note">
          Access is by invite code for now. Subscriptions will be paid in USDC on Base, and managed
          here.
        </p>
      </section>
    </div>
  );
}
