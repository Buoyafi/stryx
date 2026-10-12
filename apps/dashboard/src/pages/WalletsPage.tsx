import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@stryx/toast-ui';
import { apiRequest } from '../lib/api';
import { CopyableValue } from '../components/CopyableValue';
import { DeleteWalletModal } from '../components/DeleteWalletModal';
import { ImportWalletModal } from '../components/ImportWalletModal';
import { BulkGenerateModal } from '../components/BulkGenerateModal';
import { GenerateWalletIcon } from '../lib/icons';
import { ExportKeyModal } from '../components/ExportKeyModal';
import { NftTransferModal } from '../components/nft-transfer/NftTransferModal';
import { EditableName } from '../components/EditableName';
import { ApiError } from '../lib/api';
import { balanceKeys, invalidateWalletListBalances } from '../lib/balance-cache';
import { chainById } from '@stryx/chains';
import { ChainPicker } from '../components/disperse/ChainPicker';
import { formatUnits } from '../lib/wei-format';
import { Notice } from '../components/Notice';

/** "0.0123 ETH": the chain's own symbol and decimals, never assumed to be ETH. */
function formatNative(wei: string, chainId: number): string {
  const c = chainById(chainId);
  return `${formatUnits(wei, c?.nativeCurrency.decimals ?? 18)} ${c?.nativeCurrency.symbol ?? ''}`.trim();
}

interface ChainWalletBalance {
  walletId: string;
  wei: string;
  error?: string;
}

const BALANCE_CHAIN_KEY = 'stryx.wallets.balanceChain';
function readStoredChain(): number | null {
  try {
    const v = Number(localStorage.getItem(BALANCE_CHAIN_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function storeChain(chainId: number): void {
  try {
    localStorage.setItem(BALANCE_CHAIN_KEY, String(chainId));
  } catch {
    // Remembering the choice is a convenience only.
  }
}

// The shape the API returns for a wallet summary (key material excluded, by design).
interface WalletSummary {
  id: string;
  address: string;
  label: string | null;
  tier: 'TREASURY' | 'HOT' | 'MINT';
  status: 'ACTIVE' | 'ARCHIVED' | 'COMPROMISED';
  /** How Stryx came to hold the key: independent of tier (purpose). */
  origin: 'GENERATED' | 'IMPORTED';
  keyVersion: number;
  createdAt: string;
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string; error?: string } | null;
    return body?.message ?? body?.error ?? `Failed (${err.status})`;
  }
  return 'Could not reach the API.';
}

export function WalletsPage() {
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [deleting, setDeleting] = useState<WalletSummary | null>(null);
  const [exporting, setExporting] = useState<WalletSummary | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showBulkGenerate, setShowBulkGenerate] = useState(false);
  const [transferFromWalletId, setTransferFromWalletId] = useState<string | 'any' | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => apiRequest<WalletSummary[]>('/wallets'),
  });

  // Every wallet's balance on ONE chain, shown as a column: pick the chain above the table.
  const { data: chainData } = useQuery({ queryKey: ['chains'], queryFn: () => apiRequest<{ chains: { chainId: number; name: string }[] }>('/chains') });
  const chains = chainData?.chains ?? [];
  const [pickedChain, setPickedChain] = useState<number | null>(readStoredChain);
  const balanceChain = chains.some((c) => c.chainId === pickedChain) ? pickedChain : (chains[0]?.chainId ?? null);
  const chainBalances = useQuery({
    queryKey: balanceKeys.chain(balanceChain ?? 0),
    queryFn: () => apiRequest<{ balances: ChainWalletBalance[] }>(`/wallets/balances?chainId=${balanceChain}`),
    enabled: balanceChain !== null && (data?.length ?? 0) > 0,
  });
  const balanceOf = (walletId: string) => chainBalances.data?.balances.find((b) => b.walletId === walletId);
  const readable = chainBalances.data?.balances.filter((b) => !b.error) ?? [];
  const unreadable = (chainBalances.data?.balances.length ?? 0) - readable.length;
  const totalWei = readable.reduce((sum, b) => sum + BigInt(b.wei), 0n);

  // One ping when the load failure first appears; the banner stays while the list is empty because of
  // it.
  const hadLoadErrorRef = useRef(false);
  useEffect(() => {
    if (error && !hadLoadErrorRef.current) {
      toast.error('Could not load wallets', 'Try signing out and back in.');
      hadLoadErrorRef.current = true;
    } else if (!error) {
      hadLoadErrorRef.current = false;
    }
  }, [error]);

  const archive = useMutation({
    mutationFn: (id: string) => apiRequest<WalletSummary>(`/wallets/${id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['wallets'] });
      toast.success('Wallet archived');
    },
    onError: (err) => toast.error('Could not archive wallet', apiErrorMessage(err)),
  });

  const unarchive = useMutation({
    mutationFn: (id: string) => apiRequest<WalletSummary>(`/wallets/${id}/unarchive`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['wallets'] });
      toast.success('Wallet restored');
    },
    onError: (err) => toast.error('Could not restore wallet', apiErrorMessage(err)),
  });


  return (
    <div>
      <header className="page-head">
        <h1 style={{ fontSize: 18 }}>Wallets</h1>
        <div className="page-head__actions">
          <button onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          <button className="primary generate-wallet-btn" onClick={() => setShowBulkGenerate(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <GenerateWalletIcon aria-hidden width={18} height={18} />
            Generate wallet
          </button>
          <button className="primary" onClick={() => setShowImport(true)} title="Import one or more wallets by private key">
            Import wallets
          </button>
          <button onClick={() => setTransferFromWalletId('any')}>Transfer NFTs…</button>
        </div>
      </header>

      {showImport && (
        <ImportWalletModal
          onCancel={() => setShowImport(false)}
          onImported={() => {
            void queryClient.invalidateQueries({ queryKey: ['wallets'] });
            // An imported key may already hold funds; the pickers' lists must be re-read to include it.
            void invalidateWalletListBalances(queryClient);
          }}
        />
      )}

      {showBulkGenerate && (
        <BulkGenerateModal
          onCancel={() => setShowBulkGenerate(false)}
          onGenerated={() => {
            void queryClient.invalidateQueries({ queryKey: ['wallets'] });
            void invalidateWalletListBalances(queryClient);
          }}
        />
      )}

      {transferFromWalletId !== null && (
        <NftTransferModal
          onCancel={() => setTransferFromWalletId(null)}
          onTransferred={() => void invalidateWalletListBalances(queryClient)}
          {...(transferFromWalletId !== 'any' ? { initialWalletId: transferFromWalletId } : {})}
        />
      )}

      {isLoading && <p style={{ color: 'var(--stryx-sub)' }}>Loading wallets…</p>}

      {error && (
        <Notice tone="error">
          Couldn't load wallets. Try signing out and back in.
        </Notice>
      )}

      {data && data.length === 0 && (
        <div className="empty-state">
          <div style={{ marginBottom: 6, color: 'var(--stryx-ink)' }}>No wallets yet</div>
          <div style={{ fontSize: 12.5 }}>
            Generate one to get started, or import an existing key you already hold a backup of.
          </div>
        </div>
      )}

      {data && data.length > 0 && chains.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--stryx-sub)' }}>Balances on</span>
          <ChainPicker
            chains={chains}
            value={balanceChain}
            onChange={(id) => {
              setPickedChain(id);
              storeChain(id);
            }}
          />
          {balanceChain !== null && chainBalances.data && (
            <span style={{ fontSize: 12 }} aria-label="Balance total">
              Total <span className="mono">{formatNative(totalWei.toString(), balanceChain)}</span>
            </span>
          )}
        </div>
      )}
      {chainBalances.isError && <Notice tone="error" compact className="wallets-notice">{`Couldn't read balances: ${apiErrorMessage(chainBalances.error)}`}</Notice>}
      {unreadable > 0 && <Notice tone="warn" compact className="wallets-notice">{`${unreadable} wallet${unreadable === 1 ? '' : 's'} couldn't be read on this chain, so the total may be low.`}</Notice>}

      {data && data.length > 0 && (
        <div className="stryx-scroll wallets-scroll">
        <table className="dense wallets-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Address</th>
              {balanceChain !== null && <th>Balance</th>}
              <th>Tier</th>
              <th>Status</th>
              <th>Key version</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data
              .filter((w) => (showArchived ? true : w.status !== 'ARCHIVED'))
              .map((w) => (
                <tr key={w.id} className={`wl-row${w.status === 'ARCHIVED' ? ' row-idle' : ''}`}>
                  <td className="wt-label">
                    <span className="wt-name">
                      <EditableName walletId={w.id} label={w.label} />
                      {w.origin === 'IMPORTED' && (
                        <span
                          className="pill idle"
                          style={{ fontSize: 11, padding: '1px 7px' }}
                          title="Imported: you supplied this key, so you presumably still hold the original."
                        >
                          imported
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="wt-address"><CopyableValue value={w.address} display={shortAddress(w.address)} /></td>
                  {balanceChain !== null && (
                    <td className="mono wt-balance" data-label="Balance">
                      {(() => {
                        const b = balanceOf(w.id);
                        if (chainBalances.isLoading) return <span style={{ color: 'var(--stryx-sub)' }}>…</span>;
                        if (!b) return <span style={{ color: 'var(--stryx-sub)' }}>-</span>;
                        if (b.error) return <span className="pill fail" title={b.error}>unreadable</span>;
                        return formatNative(b.wei, balanceChain);
                      })()}
                    </td>
                  )}
                  <td className="wt-tier" data-label="Tier">{w.tier}</td>
                  <td className="wt-status">
                    <span className={`pill ${w.status === 'ACTIVE' ? 'live' : w.status === 'COMPROMISED' ? 'fail' : 'idle'}`}>
                      {w.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="mono wt-key">v{w.keyVersion}</td>
                  <td className="wt-actions" style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    {w.status === 'ARCHIVED' ? (
                      <span className="wt-buttons" style={{ display: 'inline-flex', gap: 6 }}>
                        <button
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => unarchive.mutate(w.id)}
                          disabled={unarchive.isPending}
                        >
                          Restore
                        </button>
                        <button style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setExporting(w)}>
                          Export key
                        </button>
                        <button
                          className="danger"
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => setDeleting(w)}
                        >
                          Delete
                        </button>
                      </span>
                    ) : (
                      <span className="wt-buttons" style={{ display: 'inline-flex', gap: 6 }}>
                        <button style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setTransferFromWalletId(w.id)}>
                          Transfer NFTs
                        </button>
                        <button style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setExporting(w)}>
                          Export key
                        </button>
                        <button
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => archive.mutate(w.id)}
                          disabled={archive.isPending}
                        >
                          Archive
                        </button>
                        <button className="danger" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setDeleting(w)}>
                          Delete
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {exporting && <ExportKeyModal walletId={exporting.id} address={exporting.address} onClose={() => setExporting(null)} />}

      {deleting && (
        <DeleteWalletModal
          walletId={deleting.id}
          address={deleting.address}
          label={deleting.label ?? null}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void queryClient.invalidateQueries({ queryKey: ['wallets'] });
            void invalidateWalletListBalances(queryClient);
            toast.success('Wallet deleted');
          }}
        />
      )}
    </div>
  );
}
