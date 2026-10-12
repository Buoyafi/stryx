import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { DISPLAY_NAME_MAX, displayNameProblem, normaliseDisplayName, useMe, useSaveProfile } from '../lib/profile';
import { Orbit } from './WelcomeCard';
import { Notice } from './Notice';

/** "Good morning" and so on, by the viewer's own clock. */
export function greeting(hour: number): string {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function saveProblem(err: unknown): string {
  if (err instanceof ApiError) return (err.body as { message?: string } | null)?.message ?? 'Could not save your name. Try again.';
  return 'Could not reach Stryx. Try again.';
}

/** Home's card for a signed-in member, where a visitor sees "Got a code?". */
export function MemberCard({ justJoined, now = new Date() }: { justJoined: boolean; now?: Date }) {
  const me = useMe();
  const save = useSaveProfile();
  const [editing, setEditing] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const name = me.data?.displayName ?? null;
  const asking = !!me.data && (editing || (justJoined && !name && !skipped));

  useEffect(() => {
    if (asking) {
      setDraft(name ?? '');
      inputRef.current?.focus();
    }
    // Only when the form opens (deps on purpose): typing must not be reset by a refetch.
  }, [asking]);

  if (me.isLoading) {
    return (
      <section className="welcome welcome--member" aria-busy="true" aria-label="Loading your account">
        <div className="skeleton" style={{ height: 20, width: '30%' }} />
        <div className="skeleton" style={{ height: 28, width: '55%' }} />
      </section>
    );
  }
  if (!me.data) return null;

  const problem = displayNameProblem(draft);
  const cleaned = normaliseDisplayName(draft);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || !cleaned) return;
    save.mutate({ displayName: cleaned }, { onSuccess: () => setEditing(false) });
  };

  if (asking) {
    return (
      <section className="welcome welcome--member" aria-labelledby="member-title">
        <Orbit />
        <span className="welcome__eyebrow">{justJoined && !editing ? 'You are in' : 'Your name'}</span>
        <h2 id="member-title" className="welcome__q">
          {justJoined && !editing ? 'You are in.' : 'What should we call you?'}
        </h2>
        <p className="welcome__p">
          {justJoined && !editing ? 'Welcome to Stryx. What should we call you? We will greet you by it every time you sign in.' : 'We greet you by it every time you sign in. Only you see it.'}
        </p>
        <form className="welcome__name-form" onSubmit={submit} noValidate>
          <label htmlFor="member-name" className="sr-only">
            Your name
          </label>
          <input
            ref={inputRef}
            id="member-name"
            className={`welcome__name${problem ? ' is-bad' : ''}`}
            value={draft}
            maxLength={DISPLAY_NAME_MAX + 8}
            autoComplete="nickname"
            placeholder="Your name"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'member-name-problem' : undefined}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="welcome__actions">
            <button type="submit" className="primary" disabled={!!problem || !cleaned || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setSkipped(true);
                save.reset();
              }}
            >
              {editing ? 'Cancel' : 'Skip for now'}
            </button>
          </div>
        </form>
        {problem && (
          <span id="member-name-problem" className="welcome__problem">
            {problem}
          </span>
        )}
        {save.isError && (
          <Notice tone="error" compact className="welcome__notice">
            {saveProblem(save.error)}
          </Notice>
        )}
      </section>
    );
  }

  const title = justJoined ? (name ? `You are in, ${name}.` : 'You are in.') : name ? `Welcome back, ${name}.` : 'Welcome back.';
  return (
    <section className="welcome welcome--member" aria-labelledby="member-title">
      <Orbit />
      <span className="welcome__eyebrow">{justJoined ? 'Welcome to Stryx' : greeting(now.getHours())}</span>
      <h2 id="member-title" className="welcome__q">
        {title}
      </h2>
      <p className="welcome__p">
        {justJoined ? 'Wallets, Mint and Activity are open. Start with a wallet to mint from.' : 'Your wallets, schedules and mint history are where you left them.'}
      </p>
      <div className="welcome__actions">
        {justJoined ? (
          <Link className="welcome__cta" to="/wallets">
            Create your first wallet
          </Link>
        ) : (
          <Link className="welcome__cta" to="/mint">
            Mint a drop
          </Link>
        )}
        <Link className="welcome__ghost" to="/activity">
          Activity
        </Link>
      </div>
      {/* Once there is a name, it is changed on Profile; this card only offers to add one. */}
      {!name && (
        <p className="welcome__foot">
          <button type="button" className="welcome__link" onClick={() => setEditing(true)}>
            Add your name
          </button>
        </p>
      )}
    </section>
  );
}
