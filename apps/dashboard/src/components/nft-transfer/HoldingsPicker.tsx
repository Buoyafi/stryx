import { useQuery } from '@tanstack/react-query';
import { fetchHoldings, tokenKey, type NftHolding, type NftTransferItemInput } from '../../lib/nft-transfer';
import { NftThumb } from './NftThumb';
import { Notice } from '../Notice';

interface WalletLite {
  id: string;
  address: string;
  label: string | null;
  status: string;
}

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Select source wallets, then pick which of each one's NFTs to move. */
export function HoldingsPicker({
  wallets,
  chainId,
  checkedWallets,
  onToggleWallet,
  selected,
  onToggleToken,
  onSetWalletSelection,
}: {
  wallets: readonly WalletLite[];
  chainId: number;
  checkedWallets: ReadonlySet<string>;
  onToggleWallet: (id: string) => void;
  selected: ReadonlyMap<string, NftTransferItemInput>;
  onToggleToken: (item: NftTransferItemInput) => void;
  onSetWalletSelection: (items: readonly NftTransferItemInput[], select: boolean) => void;
}) {
  const active = wallets.filter((w) => w.status === 'ACTIVE');

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--stryx-sub)', marginBottom: 6 }}>Wallets</div>
      <div className="stryx-scroll" style={{ border: '1px solid var(--dash-line-strong)', borderRadius: 'var(--radius)', maxHeight: 160, overflowY: 'auto', marginBottom: 16 }}>
        {active.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--stryx-sub)', fontSize: 12.5 }}>No active wallets.</div>
        ) : (
          active.map((w) => (
            <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer' }}>
              <input type="checkbox" checked={checkedWallets.has(w.id)} onChange={() => onToggleWallet(w.id)} />
              <span style={{ fontSize: 12.5 }}>{w.label ? `${w.label} · ` : ''}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--stryx-sub)' }}>{shortAddress(w.address)}</span>
            </label>
          ))
        )}
      </div>

      {[...checkedWallets].map((walletId) => {
        const wallet = active.find((w) => w.id === walletId);
        if (!wallet) return null;
        return (
          <WalletHoldings
            key={walletId}
            wallet={wallet}
            chainId={chainId}
            selected={selected}
            onToggleToken={onToggleToken}
            onSetWalletSelection={onSetWalletSelection}
          />
        );
      })}
    </div>
  );
}

function WalletHoldings({
  wallet,
  chainId,
  selected,
  onToggleToken,
  onSetWalletSelection,
}: {
  wallet: WalletLite;
  chainId: number;
  selected: ReadonlyMap<string, NftTransferItemInput>;
  onToggleToken: (item: NftTransferItemInput) => void;
  onSetWalletSelection: (items: readonly NftTransferItemInput[], select: boolean) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['nft-holdings', wallet.id, chainId],
    queryFn: () => fetchHoldings(wallet.id, chainId),
    staleTime: 20_000,
  });

  const toItem = (h: NftHolding): NftTransferItemInput => ({ walletId: wallet.id, contract: h.contract, tokenId: h.tokenId, standard: h.standard, amount: h.amount });

  return (
    <div style={{ marginBottom: 16, paddingLeft: 4, borderLeft: '2px solid var(--dash-line-strong)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingLeft: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{wallet.label ?? shortAddress(wallet.address)}</span>
        {data && data.source === 'ledger' && (
          <span className="pill idle" style={{ fontSize: 10 }} title="No live NFT indexer configured for this chain: only tokens minted through Stryx are shown.">
            minted through Stryx only
          </span>
        )}
      </div>

      <div style={{ paddingLeft: 8 }}>
        {isLoading && <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5 }}>Loading holdings…</p>}
        {error && (
          <Notice tone="error">{`Couldn't load holdings: ${error instanceof Error ? error.message : String(error)}`}</Notice>
        )}
        {data && data.holdings.length === 0 && <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5 }}>No NFTs found on this chain.</p>}

        {data && data.holdings.length > 0 && (
          <>
            {(() => {
              const items = data.holdings.map(toItem);
              const allSelected = items.every((i) => selected.has(tokenKey(i)));
              return (
                <button type="button" onClick={() => onSetWalletSelection(items, !allSelected)} style={{ fontSize: 11, padding: '2px 8px', marginBottom: 8 }}>
                  {allSelected ? 'Clear' : 'Select all'}
                </button>
              );
            })()}
            {groupByContract(data.holdings).map(([contract, tokens]) => (
              <div key={contract} style={{ marginBottom: 10 }}>
                <div className="mono" style={{ fontSize: 11, color: 'var(--stryx-sub)', marginBottom: 4 }}>{shortAddress(contract)}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {tokens.map((t) => {
                    const item = toItem(t);
                    const key = tokenKey(item);
                    const checked = selected.has(key);
                    return (
                      <label key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, cursor: 'pointer' }}>
                        <span style={{ position: 'relative', display: 'inline-block' }}>
                          <NftThumb imageUrl={t.imageUrl} tokenId={t.tokenId} size={48} />
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => onToggleToken(item)}
                            style={{ position: 'absolute', top: 2, left: 2 }}
                          />
                        </span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--stryx-sub)' }}>#{t.tokenId}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function groupByContract(holdings: readonly NftHolding[]): [string, NftHolding[]][] {
  const groups = new Map<string, NftHolding[]>();
  for (const h of holdings) {
    const list = groups.get(h.contract);
    if (list) list.push(h);
    else groups.set(h.contract, [h]);
  }
  return [...groups.entries()];
}
