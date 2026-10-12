import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { stepUp } from '../lib/step-up';
import { Notice } from './Notice';
import { useViewer } from '../lib/viewer';
import { chainById } from '@stryx/chains';
import { confirmWithWallet, messageChainId, reasonOf } from '../lib/account';
import { classifyWalletError, type DiscoveredWallet } from '../lib/wallet';
import { useConnectedWallet, walletConnectStore } from '../lib/wallet-connect-store';
import { useEscapeToClose } from '../lib/useEscapeToClose';

/** Re-prove it is you for a sensitive action, and get a short step-up grant. */
export function StepUpPrompt(props: { reason: string; onCancel: () => void; onGranted: () => void }) {
  const viewer = useViewer();
  if (viewer.kind === 'member' && viewer.signedInWith === 'wallet') return <WalletStepUp {...props} />;
  return <TokenStepUp {...props} />;
}

function WalletStepUp({ reason, onCancel, onGranted }: { reason: string; onCancel: () => void; onGranted: () => void }) {
  const wallet = useConnectedWallet(walletConnectStore);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const found = wallet.wallets;
  useEffect(() => {
    if (walletConnectStore.getSnapshot().wallets === null) void walletConnectStore.discover();
  }, []);

  async function confirm(picked: DiscoveredWallet | null) {
    setError(null);
    setChecking(true);
    try {
      if (picked) await walletConnectStore.connect(picked);
      const state = walletConnectStore.getSnapshot();
      if (state.status !== 'connected' || !state.session || !state.account) throw new Error(state.error ?? 'The wallet did not connect.');
      await confirmWithWallet({ session: state.session, address: state.account, chainId: messageChainId(state.chainId, (id) => !!chainById(id)) });
      onGranted();
    } catch (err) {
      setChecking(false);
      setError(classifyWalletError(err).kind === 'rejected' ? 'You declined the signature.' : reasonOf(err, 'Could not confirm. Try again.'));
    }
  }

  useEscapeToClose(onCancel);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="stepup-title">
        <h2 id="stepup-title" style={{ fontSize: 15, marginBottom: 8 }}>
          Confirm it's you
        </h2>
        <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginBottom: 14 }}>
          {reason} Sign a short message with the wallet you signed in with. It is free: no gas, no transaction.
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={checking}>
            Cancel
          </button>
          {wallet.status === 'connected' ? (
            <button className="primary" onClick={() => void confirm(null)} disabled={checking}>
              {checking ? 'Check your wallet…' : 'Confirm with your wallet'}
            </button>
          ) : (
            (found ?? []).map((w) => (
              <button key={w.id} className="primary" onClick={() => void confirm(w)} disabled={checking}>
                {checking ? 'Check your wallet…' : `Confirm with ${w.name}`}
              </button>
            ))
          )}
        </div>
        {wallet.status !== 'connected' && found !== null && found.length === 0 && (
          <p style={{ color: 'var(--stryx-sub)', fontSize: 12, marginTop: 10 }}>No wallet found in this browser. Open this page where your wallet is installed.</p>
        )}
      </div>
    </div>
  );
}

function TokenStepUp({ reason, onCancel, onGranted }: { reason: string; onCancel: () => void; onGranted: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Enter twice in a row arrives before the button is disabled: only the first may send.
  const sending = useRef(false);

  async function submit() {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    setChecking(true);
    try {
      await stepUp(value);
      onGranted();
    } catch (err) {
      sending.current = false;
      setChecking(false);
      setError(err instanceof ApiError && err.status === 401 ? 'Incorrect. Try again.' : 'Could not verify. Try again.');
    }
  }

  useEscapeToClose(onCancel);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Confirm it's you</h2>
        <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginBottom: 14 }}>
          {reason} Re-enter your API token to continue.
        </p>
        <input
          type="password"
          className="mono"
          placeholder="API token"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && value && void submit()}
          autoFocus
        />
        {error && (
          <Notice tone="error">
            {error}
          </Notice>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={checking}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={!value || checking}>
            {checking ? 'Checking…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
