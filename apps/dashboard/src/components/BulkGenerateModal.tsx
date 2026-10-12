import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from '@stryx/toast-ui';
import { apiRequest, ApiError } from '../lib/api';
import { toCsv, downloadTextFile } from '../lib/csv-export';
import { writeDisprefill } from '../lib/disperse-prefill';
import { shortError } from '../lib/short-error';
import { Notice } from './Notice';
import { useEscapeToClose } from '../lib/useEscapeToClose';

interface GeneratedWallet {
  id: string;
  address: string;
  label: string | null;
}

/** Generates several wallets in one action, through POST /wallets/bulk. */
export function BulkGenerateModal({ onCancel, onGenerated }: { onCancel: () => void; onGenerated: () => void }) {
  const navigate = useNavigate();
  const [count, setCount] = useState('1');
  const [labelPrefix, setLabelPrefix] = useState('');
  const [formatError, setFormatError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<GeneratedWallet[] | null>(null);
  const [shortfall, setShortfall] = useState<string | null>(null);

  async function submit() {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      setFormatError('Enter a whole number between 1 and 100.');
      return;
    }

    setFormatError(null);
    setServerError(null);
    setSubmitting(true);
    try {
      const answer = await apiRequest<GeneratedWallet[] | { partial: true; requested: number; wallets: GeneratedWallet[]; message?: string }>('/wallets/bulk', {
        method: 'POST',
        body: { count: n, ...(labelPrefix.trim() ? { labelPrefix: labelPrefix.trim() } : {}) },
      });
      const wallets = Array.isArray(answer) ? answer : answer.wallets;
      setCreated(wallets);
      onGenerated();
      if (Array.isArray(answer)) {
        toast.success('Wallets generated', `${wallets.length} wallet${wallets.length === 1 ? '' : 's'} ready`);
      } else {
        // It stopped part way. The ones it made are real and listed: generating the full count again would double up.
        setShortfall(`Only ${wallets.length} of ${answer.requested} were generated before it stopped. These ${wallets.length} are ready to use; generate the other ${answer.requested - wallets.length} separately.`);
        toast.error('Some wallets were not generated', `${wallets.length} of ${answer.requested} ready`);
      }
    } catch (err) {
      let message: string;
      if (err instanceof ApiError) {
        const body = err.body as { message?: string; error?: string } | null;
        message = body?.message ?? body?.error ?? `Generate failed (HTTP ${err.status}).`;
      } else {
        message = 'Could not reach the API.';
      }
      setServerError(message);
      toast.error('Could not generate wallets', shortError(message));
    } finally {
      setSubmitting(false);
    }
  }

  // Not while the request is out: wallets made after the dialog closed would never be shown.
  const close = submitting ? undefined : onCancel;
  useEscapeToClose(close);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {created ? (
          <>
            <h2 className="msg-live" style={{ fontSize: 15, marginBottom: 8 }}>
              {created.length} wallet{created.length === 1 ? '' : 's'} generated
            </h2>
            {shortfall && <Notice tone="warn">{shortfall}</Notice>}
            <div
              className="mono stryx-scroll"
              style={{
                fontSize: 12,
                maxHeight: 220,
                overflowY: 'auto',
                marginBottom: 16,
                padding: '10px 12px',
                background: 'var(--dash-raised)',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--stryx-line)',
              }}
            >
              {created.map((w) => (
                <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>{w.label ?? '(unnamed)'}</span>
                  <span style={{ color: 'var(--stryx-sub)' }}>{w.address}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                onClick={() => downloadTextFile('wallets.csv', toCsv(created))}
                style={{ fontSize: 12.5 }}
              >
                Download CSV
              </button>
              <button
                onClick={() => {
                  writeDisprefill(created.map((w) => ({ id: w.id, address: w.address, label: w.label })));
                  navigate('/disperse');
                }}
                style={{ fontSize: 12.5 }}
              >
                Send to Disperse
              </button>
              <button className="primary" onClick={onCancel} style={{ fontSize: 12.5 }}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: 15, marginBottom: 8 }}>Generate wallets</h2>
            <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginBottom: 14, lineHeight: 1.6 }}>
              Generates real, separate keypairs, encrypted and custodied exactly the same way a
              single generated wallet's key is. Keys never leave the server.
            </p>

            <div style={{ fontSize: 12, color: 'var(--stryx-sub)', marginBottom: 4 }}>Count (1-100)</div>
            <input
              className="mono"
              style={{ width: 100 }}
              value={count}
              onChange={(e) => {
                setCount(e.target.value);
                if (formatError) setFormatError(null);
              }}
              autoFocus
            />
            {formatError && <Notice tone="error">{formatError}</Notice>}

            <div style={{ fontSize: 12, color: 'var(--stryx-sub)', margin: '14px 0 4px' }}>Label prefix (optional)</div>
            <input
              value={labelPrefix}
              onChange={(e) => setLabelPrefix(e.target.value)}
              placeholder={'e.g. Mint → Mint-01, Mint-02, ...'}
            />

            {serverError && <Notice tone="error">{serverError}</Notice>}

            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
              <button className="primary" onClick={submit} disabled={!count || submitting}>
                {submitting ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
