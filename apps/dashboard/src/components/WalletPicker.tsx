import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../lib/api';
import { balanceKeys, PICKER_BALANCE_STALE_MS, refetchStaleChainBalances } from '../lib/balance-cache';

interface WalletSummary {
  id: string;
  address: string;
  label: string | null;
  tier: string;
  status: string;
}

interface WalletBalance {
  walletId: string;
  address: string;
  wei: string;
  formatted: string;
  error?: string;
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

/** A wallet dropdown that shows each wallet's balance on the target chain. */
export function WalletPicker({
  wallets,
  chainId,
  selectedId,
  onSelect,
  excludeId,
}: {
  wallets: WalletSummary[];
  chainId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  /** Omit a wallet from the list (e.g. the disperse source can't also be a recipient). */
  excludeId?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { data, isLoading } = useQuery({
    queryKey: balanceKeys.chain(chainId),
    queryFn: () => apiRequest<{ balances: WalletBalance[] }>(`/wallets/balances?chainId=${chainId}`),
    enabled: chainId !== '',
    staleTime: PICKER_BALANCE_STALE_MS,
  });

  // The list is keyed by chain only, so the selected wallet's balance comes from the same cached data
  // as the list.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (chainId !== '' && (open || selectedId !== '')) {
      void refetchStaleChainBalances(queryClient, chainId);
    }
  }, [open, selectedId, chainId, queryClient]);

  const balanceFor = (walletId: string) => data?.balances.find((b) => b.walletId === walletId);
  const selectable = wallets.filter((w) => w.status === 'ACTIVE' && w.id !== excludeId);
  const selected = wallets.find((w) => w.id === selectedId);

  if (chainId === '') {
    return (
      <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, margin: 0 }}>
        Pick a chain first to see wallet balances.
      </p>
    );
  }

  function renderBalance(walletId: string) {
    const bal = balanceFor(walletId);
    if (isLoading && !bal) return <span style={{ color: 'var(--stryx-sub)' }}>…</span>;
    if (bal?.error) {
      return (
        <span className="tag tag--error" title={bal.error}>
          unavailable
        </span>
      );
    }
    const empty = bal ? BigInt(bal.wei) === 0n : true;
    return (
      <span style={{ color: empty ? 'var(--stryx-sub)' : 'var(--stryx-ink)' }}>{bal?.formatted ?? '0'}</span>
    );
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      {/* Collapsed trigger: shows only the current selection */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 12px',
          textAlign: 'left',
          borderColor: open ? 'var(--stryx-accent)' : 'var(--dash-line-strong)',
        }}
      >
        {selected ? (
          <>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 12.5 }}>{selected.label ?? 'unnamed'}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--stryx-sub)' }}>
                {shortAddress(selected.address)} · {selected.tier}
              </span>
            </span>
            <span className="mono" style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
              {renderBalance(selected.id)}
              <span style={{ color: 'var(--stryx-sub)', fontSize: 10 }}>{open ? '\u25b4' : '\u25be'}</span>
            </span>
          </>
        ) : (
          <>
            <span style={{ color: 'var(--stryx-sub)' }}>Select a wallet…</span>
            <span style={{ color: 'var(--stryx-sub)', fontSize: 10 }}>{open ? '\u25b4' : '\u25be'}</span>
          </>
        )}
      </button>

      {/* Absolutely positioned, so it overlays the form instead of pushing it down. */}
      {open && (
        <div
          role="listbox"
          className="stryx-scroll"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 20,
            background: 'var(--stryx-card)',
            border: '1px solid var(--dash-line-strong)',
            borderRadius: 'var(--radius)',
            maxHeight: 260,
            overflowY: 'auto',
            boxShadow: 'var(--dash-shadow)',
          }}
        >
          {selectable.length === 0 ? (
            <div style={{ padding: 12, color: 'var(--stryx-sub)', fontSize: 12.5 }}>No active wallets.</div>
          ) : (
            selectable.map((w) => (
              <button
                key={w.id}
                type="button"
                role="option"
                aria-selected={selectedId === w.id}
                onClick={() => {
                  onSelect(w.id);
                  setOpen(false);
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 12px',
                  textAlign: 'left',
                  border: 'none',
                  borderRadius: 0,
                  background: selectedId === w.id ? 'var(--dash-raised)' : 'transparent',
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 12.5 }}>{w.label ?? 'unnamed'}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--stryx-sub)' }}>
                    {shortAddress(w.address)} · {w.tier}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12.5 }}>{renderBalance(w.id)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
