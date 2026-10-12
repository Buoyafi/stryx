import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { chainById } from '@stryx/chains';
import { authOptions, checkCode, errorCode, heldTicket, messageChainId, reasonOf, signInWithWallet, type TermsVersions } from '../lib/account';
import { WalletError, classifyWalletError, type DiscoveredWallet } from '../lib/wallet';
import { walletConnectStore, type WalletConnectStore } from '../lib/wallet-connect-store';
import { WalletPickerModal } from './connect-wallet/WalletPickerModal';
import { Notice } from './Notice';
import { TermsCheckbox } from './TermsCheckbox';

type Step = 'ask' | 'code' | 'wallet' | 'return' | 'signing' | 'nope';

/** Where "Join the waitlist" goes: the landing page's waitlist (VITE_WAITLIST_URL). */
const WAITLIST_URL: string | undefined = import.meta.env.VITE_WAITLIST_URL;

/** The operator's "use the API token" link. */
export function showOperatorLogin(env: { DEV?: boolean; VITE_SHOW_OPERATOR_LOGIN?: string }): boolean {
  return env.DEV === true || env.VITE_SHOW_OPERATOR_LOGIN === 'true';
}
const SHOW_OPERATOR_LOGIN = showOperatorLogin(import.meta.env);

/** Split whatever was typed or pasted into the two 4-character halves of STRYX-XXXX-XXXX. */
export function splitCode(raw: string): [string, string] {
  const body = raw.toUpperCase().replace(/^\s*STRYX/, '').replace(/[^A-Z0-9]/g, '');
  return [body.slice(0, 4), body.slice(4, 8)];
}

/** The slow-turning orbit behind Home's cards. */
export function Orbit() {
  return (
    <div className="welcome__orbit" aria-hidden="true">
      <i style={{ ['--r' as string]: '0deg' }} />
      <i style={{ ['--r' as string]: '60deg' }} />
      <i style={{ ['--r' as string]: '-60deg' }} />
      <b />
    </div>
  );
}

/** The code from an invite email's link (/home?code=STRYX-XXXX-XXXX), or null. */
export function codeFromLink(search: string): [string, string] | null {
  const raw = new URLSearchParams(search).get('code');
  if (!raw) return null;
  const parts = splitCode(raw);
  return parts[0].length === 4 && parts[1].length === 4 ? parts : null;
}

function Steps({ at }: { at: 0 | 1 }) {
  return (
    <ol className="welcome__steps" aria-label="Progress">
      {['Code', 'Wallet', 'In'].map((label, i) => (
        <li key={label} className={i < at ? 'is-done' : i === at ? 'is-now' : ''} aria-current={i === at ? 'step' : undefined}>
          <i>{i < at ? '✓' : i + 1}</i>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** Home's front door for a visitor. One question, "Got a code?", then the code, then the wallet sign-in. */
export function WelcomeCard({ onSignedIn, store = walletConnectStore }: { onSignedIn: () => void; store?: WalletConnectStore }) {
  // Arriving from an invite email: the code is already in the boxes, one tap from checking it.
  const [linked] = useState(() => (typeof window === 'undefined' ? null : codeFromLink(window.location.search)));
  const [step, setStep] = useState<Step>(() => (heldTicket() ? 'wallet' : linked ? 'code' : 'ask'));
  const [parts, setParts] = useState<[string, string]>(() => linked ?? ['', '']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // The versions a NEW account has to accept (null when the server is not asking), and whether the box is ticked.
  const [terms, setTerms] = useState<TermsVersions | null>(null);
  const [ticked, setTicked] = useState(false);
  const connectRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const secondRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  const go = (next: Step, message: string | null = null) => {
    setStep(next);
    setError(message);
  };

  // The code leaves the address bar once read, so it is not left in history or a shared screenshot.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('code')) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, []);

  useEffect(() => {
    let live = true;
    void authOptions().then((o) => live && setTerms(o.terms));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (step === 'code') firstRef.current?.focus();
    // Look for wallets ahead of the click, so the chooser opens already filled in.
    if (step === 'wallet' || step === 'return') void store.discover();
  }, [step, store]);

  // "Code needed" on a drop card scrolls here and asks the question.
  useEffect(() => {
    const onAsk = () => {
      cardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      if (step === 'ask') go('code');
    };
    window.addEventListener('stryx:ask-code', onAsk);
    return () => window.removeEventListener('stryx:ask-code', onAsk);
  }, [step]);

  async function submitCode() {
    const code = parts.join('');
    if (code.length < 8) return setError('The code has 8 characters after STRYX.');
    setBusy(true);
    setError(null);
    try {
      await checkCode(`STRYX-${parts[0]}-${parts[1]}`);
      go('wallet');
    } catch (err) {
      setError(reasonOf(err, 'Could not check the code. Try again.'));
      firstRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function signIn(picked: DiscoveredWallet, returning: boolean) {
    setWalletName(picked.name);
    go('signing');
    try {
      await store.connect(picked);
      const state = store.getSnapshot();
      if (state.status !== 'connected' || !state.session || !state.account) {
        return go(returning ? 'return' : 'wallet', state.error ?? 'The wallet did not connect. Try again.');
      }
      await signInWithWallet({ session: state.session, address: state.account, chainId: messageChainId(state.chainId, (id) => !!chainById(id)), ...(!returning && terms && ticked ? { acceptedTerms: terms } : {}) });
      onSignedIn();
    } catch (err) {
      const code = errorCode(err);
      if (code === 'code_required') return go('code', 'This wallet has no account yet. Enter your invite code first.');
      if (code === 'code_expired') return go('code', 'Your code hold ran out. Enter the code again.');
      if (code === 'code_invalid') return go('code', reasonOf(err, 'That code is not valid or was already used.'));
      if (code === 'terms_required') {
        void authOptions().then((o) => setTerms(o.terms));
        setTicked(false);
        return go('wallet', 'The terms were updated. Please read them and tick the box again.');
      }
      if ((err instanceof WalletError ? err : classifyWalletError(err)).kind === 'rejected') {
        return go(returning ? 'return' : 'wallet', 'You declined the signature. Connect your wallet to try again.');
      }
      go(returning ? 'return' : 'wallet', reasonOf(err, 'Sign-in did not go through. Try again.'));
    }
  }

  const onPart = (index: 0 | 1, value: string) => {
    const joined = splitCode(value);
    // A whole code pasted or typed into either box fills both.
    if (value.replace(/[^A-Za-z0-9]/g, '').length > 4) {
      setParts(joined[1] ? joined : [joined[0], parts[1]]);
      secondRef.current?.focus();
      return;
    }
    const next: [string, string] = [...parts];
    next[index] = joined[0];
    setParts(next);
    if (error) setError(null);
    if (index === 0 && joined[0].length === 4) secondRef.current?.focus();
  };

  // A new account must tick the box (when the server asks); signing in to an existing one never does.
  const mustTick = (returning: boolean) => !returning && terms !== null;

  const connectButton = (returning: boolean) => (
    <>
      {mustTick(returning) && <TermsCheckbox checked={ticked} onChange={setTicked} />}
      <div className="welcome__actions">
        <button ref={connectRef} type="button" className="primary" aria-haspopup="dialog" disabled={mustTick(returning) && !ticked} onClick={() => setPicking(true)}>
          Connect wallet
        </button>
      </div>
      {picking && (
        <WalletPickerModal
          store={store}
          triggerRef={connectRef}
          title={returning ? 'Sign in with your wallet' : 'Choose your wallet'}
          onClose={() => setPicking(false)}
          onPick={(w) => {
            setPicking(false);
            void signIn(w, returning);
          }}
        />
      )}
    </>
  );

  return (
    <section ref={cardRef} id="welcome" className="welcome" aria-labelledby="welcome-title" aria-live="polite">
      <Orbit />
      {step === 'ask' && (
        <>
          <span className="welcome__eyebrow">Invite only, for now</span>
          <h2 id="welcome-title" className="welcome__q">
            Got a code?
          </h2>
          <p className="welcome__p">Stryx mints for you the second a drop opens. Browse the drops below freely; to schedule your own, you need an invite.</p>
          <div className="welcome__actions">
            <button type="button" className="primary" onClick={() => go('code')}>
              Yes, I have one
            </button>
            <button type="button" onClick={() => go('nope')}>
              Not yet
            </button>
          </div>
          <p className="welcome__foot">
            Been here before?{' '}
            <button type="button" className="welcome__link" onClick={() => go('return')}>
              Sign in with your wallet
            </button>
          </p>
        </>
      )}

      {step === 'code' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitCode();
          }}
          noValidate
        >
          <span className="welcome__eyebrow">Step 1 of 2</span>
          <h2 id="welcome-title" className="welcome__q">
            Enter your code
          </h2>
          <p className="welcome__p">It looks like STRYX-XXXX-XXXX. Pasting the whole thing works too.</p>
          <Steps at={0} />
          <div className={`welcome__code${error ? ' is-bad' : ''}`}>
            <span className="welcome__prefix" aria-hidden="true">
              STRYX
            </span>
            <span className="welcome__dash" aria-hidden="true">
              –
            </span>
            <input
              ref={firstRef}
              id="invite-code-1"
              className="welcome__seg"
              aria-label="Invite code, first four characters"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={parts[0]}
              onChange={(e) => onPart(0, e.target.value)}
            />
            <span className="welcome__dash" aria-hidden="true">
              –
            </span>
            <input
              ref={secondRef}
              id="invite-code-2"
              className="welcome__seg"
              aria-label="Invite code, last four characters"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={parts[1]}
              onChange={(e) => onPart(1, e.target.value)}
              onKeyDown={(e) => e.key === 'Backspace' && !parts[1] && firstRef.current?.focus()}
            />
          </div>
          {error && (
            <Notice tone="error" compact className="welcome__notice">
              {error}
            </Notice>
          )}
          <div className="welcome__actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
            <button type="button" onClick={() => go('ask')}>
              Back
            </button>
          </div>
        </form>
      )}

      {(step === 'wallet' || step === 'return') && (
        <>
          <span className="welcome__eyebrow">{step === 'wallet' ? 'Step 2 of 2' : 'Welcome back'}</span>
          <h2 id="welcome-title" className="welcome__q">
            {step === 'wallet' ? 'Code accepted. Now your wallet.' : 'Sign in with your wallet'}
          </h2>
          <p className="welcome__p">
            {step === 'wallet'
              ? 'We are holding your code for 15 minutes. Connect the wallet you want to sign in with. Signing is free: no gas, no transaction.'
              : 'Use the wallet you signed up with. No code needed again.'}
          </p>
          {step === 'wallet' && <Steps at={1} />}
          {error && (
            <Notice tone="error" compact className="welcome__notice">
              {error}
            </Notice>
          )}
          {connectButton(step === 'return')}
          {step === 'return' && (
            <p className="welcome__foot">
              <button type="button" className="welcome__link" onClick={() => go('ask')}>
                Back
              </button>
              {SHOW_OPERATOR_LOGIN && (
                <>
                  <span aria-hidden="true"> · </span>
                  <Link className="welcome__link" to="/login/token">
                    Operator? Use the API token
                  </Link>
                </>
              )}
            </p>
          )}
        </>
      )}

      {step === 'signing' && (
        <>
          <span className="welcome__eyebrow">Check your wallet</span>
          <h2 id="welcome-title" className="welcome__q">
            Sign the message in {walletName ?? 'your wallet'}
          </h2>
          <p className="welcome__p">This proves the wallet is yours. It is free: no gas, no transaction. Stryx never sees your keys.</p>
          <p className="welcome__hint" role="status">
            Waiting for your wallet…
          </p>
        </>
      )}

      {step === 'nope' && (
        <>
          <span className="welcome__eyebrow">No code yet</span>
          <h2 id="welcome-title" className="welcome__q">
            Get on the list
          </h2>
          <p className="welcome__p">Codes go out in small batches from the waitlist. Join it on the Stryx site and we will send you one when a spot opens.</p>
          <div className="welcome__actions">
            {WAITLIST_URL && (
              <a className="welcome__cta" href={WAITLIST_URL} target="_blank" rel="noopener noreferrer">
                Join the waitlist ↗
              </a>
            )}
            <button type="button" onClick={() => go('code')}>
              I have a code after all
            </button>
          </div>
        </>
      )}
    </section>
  );
}
