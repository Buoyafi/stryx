import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, apiRequest } from '../lib/api';
import { Notice } from './Notice';
import { useEscapeToClose } from '../lib/useEscapeToClose';

/** Mirrors WalletDeletionCheck in services/wallet-service (the API decides; this only shows it). */
export interface DeletionCheck {
  canDelete: boolean;
  reason: 'empty' | 'key_elsewhere' | 'confirm_key' | 'has_funds' | 'balance_unreadable' | 'scheduled';
  message: string;
  funds: { chainName: string; amount: string }[];
  keyElsewhere: 'imported' | 'exported' | null;
  scheduled: number;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string; error?: string } | null;
    return body?.message ?? body?.error ?? `Failed (${err.status})`;
  }
  return 'Could not reach the API.';
}

/** Deleting a wallet: Stryx forgets it and its key. */
export function DeleteWalletModal({ walletId, address, label, onCancel, onDeleted }: { walletId: string; address: string; label: string | null; onCancel: () => void; onDeleted: () => void }) {
  const [keySaved, setKeySaved] = useState(false);
  const check = useQuery({
    queryKey: ['wallet-deletion', walletId],
    queryFn: () => apiRequest<DeletionCheck>(`/wallets/${walletId}/deletion`),
    retry: false,
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => apiRequest<void>(`/wallets/${walletId}${keySaved ? '?keySaved=true' : ''}`, { method: 'DELETE' }),
    onSuccess: onDeleted,
  });

  const data = check.data;
  const askKey = data?.reason === 'confirm_key';
  const allowed = !!data && (data.canDelete || (askKey && keySaved));
  const blocked = data && !data.canDelete && !askKey;

  useEscapeToClose(remove.isPending ? undefined : onCancel);

  return (
    <div className="modal-backdrop" onClick={remove.isPending ? undefined : onCancel}>
      <div className="modal delete-wallet" role="dialog" aria-modal="true" aria-labelledby="delete-wallet-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="delete-wallet-title">Delete wallet</h2>
        <p className="delete-wallet__who">
          {label ? <b>{label}</b> : null} <span className="mono">{short(address)}</span>
        </p>

        {check.isLoading && <p className="delete-wallet__note">Checking its balance on every chain…</p>}
        {check.isError && (
          <Notice
            tone="error"
            action={
              <button type="button" onClick={() => void check.refetch()}>
                Try again
              </button>
            }
          >
            {errorText(check.error)}
          </Notice>
        )}

        {data && (
          <>
            {data.funds.length > 0 && (
              <ul className="delete-wallet__funds" aria-label="Still in this wallet">
                {data.funds.map((f) => (
                  <li key={f.chainName}>
                    <span>{f.chainName}</span>
                    <b className="mono">{f.amount}</b>
                  </li>
                ))}
              </ul>
            )}
            {data.reason === 'empty' && <p className="delete-wallet__note">{data.message} Anything sent to this address later cannot be reached from Stryx.</p>}
            {askKey && <Notice tone="warn">{data.message}</Notice>}
            {blocked && (
              <Notice
                tone="error"
                {...(data.reason === 'balance_unreadable'
                  ? {
                      action: (
                        <button type="button" onClick={() => void check.refetch()}>
                          Try again
                        </button>
                      ),
                    }
                  : {})}
              >
                {data.message}
              </Notice>
            )}
            {askKey && (
              <label className="delete-wallet__confirm">
                <input type="checkbox" checked={keySaved} onChange={(e) => setKeySaved(e.target.checked)} />
                <span>
                  <b>I have this wallet’s private key saved</b>
                  <small>{data.keyElsewhere === 'imported' ? 'The key you imported it with.' : 'The key you exported from Stryx.'} Without it, these funds are lost.</small>
                </span>
              </label>
            )}
          </>
        )}

        {remove.isError && <Notice tone="error">{errorText(remove.error)}</Notice>}

        <div className="delete-wallet__actions">
          <button type="button" onClick={onCancel} disabled={remove.isPending}>
            {blocked ? 'Close' : 'Cancel'}
          </button>
          {!blocked && (
            <button type="button" className="danger" onClick={() => remove.mutate()} disabled={!allowed || remove.isPending}>
              {remove.isPending ? 'Deleting…' : 'Delete wallet'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
