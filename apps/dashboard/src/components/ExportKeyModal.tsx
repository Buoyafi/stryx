import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { exportWalletKey } from '../lib/key-export';
import { StepUpPrompt } from './StepUpPrompt';
import { Notice } from './Notice';
import { useEscapeToClose } from '../lib/useEscapeToClose';
import { CLIPBOARD_CLEAR_SECONDS, copySecret } from '../lib/clipboard-secret';

const REVEAL_SECONDS = 30;

type Stage = 'warn' | 'loading' | 'shown' | 'hidden';

export function ExportKeyModal({ walletId, address, onClose }: { walletId: string; address: string; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>('warn');
  const [key, setKey] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_SECONDS);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (stage !== 'shown') return;
    const timer = setInterval(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  useEffect(() => {
    if (stage === 'shown' && secondsLeft <= 0) {
      setKey(null);
      setStage('hidden');
    }
  }, [stage, secondsLeft]);

  async function reveal() {
    setError(null);
    setStage('loading');
    try {
      const result = await exportWalletKey(walletId);
      setKey(result.privateKey);
      setSecondsLeft(REVEAL_SECONDS);
      setStage('shown');
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { error?: string } | null) : null;
      setStage('warn');
      if (body?.error === 'step_up_required') {
        setNeedsStepUp(true);
        return;
      }
      setError(body?.error === 'operator_only' ? 'Key export is only available on the operator dashboard.' : 'Could not export this key.');
    }
  }

  async function copy() {
    if (!key) return;
    try {
      await copySecret(key);
      setCopied(true);
    } catch {
      setError('Copy failed. Select the key and copy it manually.');
    }
  }

  // Not while the key is on its way: the server records the export either way.
  const busy = stage === 'loading';

  function close() {
    if (busy) return;
    setKey(null);
    onClose();
  }

  useEscapeToClose(busy ? undefined : close);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Export private key">
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Export private key</h2>
        <div className="mono" style={{ fontSize: 12, color: 'var(--stryx-sub)', marginBottom: 12, wordBreak: 'break-all' }}>
          {address}
        </div>

        {(stage === 'warn' || stage === 'loading') && (
          <>
            <Notice tone="warn">Anyone with this key controls this wallet. Reveal it only somewhere private, and never paste it into a site or chat.</Notice>
            {error && <Notice tone="error">{error}</Notice>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={close} disabled={busy}>Cancel</button>
              <button className="danger" onClick={reveal} disabled={busy}>
                {stage === 'loading' ? 'Revealing…' : 'Reveal key'}
              </button>
            </div>
          </>
        )}

        {stage === 'shown' && key && (
          <>
            <div
              className="mono"
              data-testid="exported-key"
              style={{
                fontSize: 12,
                wordBreak: 'break-all',
                padding: '10px 12px',
                background: 'var(--dash-raised)',
                border: '1px solid var(--stryx-line)',
                borderRadius: 'var(--radius)',
                marginBottom: 10,
              }}
            >
              {key}
            </div>
            <p style={{ fontSize: 12, color: 'var(--stryx-sub)', marginBottom: 14 }}>
              Hides in {secondsLeft}s. It won't be shown again.
              {copied && ` Copied: the clipboard is wiped ${CLIPBOARD_CLEAR_SECONDS} seconds after you copy, so paste it now.`}
            </p>
            {error && <Notice tone="error">{error}</Notice>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              <button className="primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        )}

        {stage === 'hidden' && (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--stryx-sub)', marginBottom: 16 }}>
              The key is hidden. Export again if you need it, which asks you to confirm it's you again.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
      </div>

      {needsStepUp && (
        <div onClick={(e) => e.stopPropagation()}>
          <StepUpPrompt
            reason="Exporting a private key gives full control of this wallet."
            onCancel={() => setNeedsStepUp(false)}
            onGranted={() => {
              setNeedsStepUp(false);
              void reveal();
            }}
          />
        </div>
      )}
    </div>
  );
}
