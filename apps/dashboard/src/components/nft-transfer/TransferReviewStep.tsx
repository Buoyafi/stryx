import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';
import { checkAddress, addressProblemText, sameAddress } from '../../lib/address';
import type { NftTransferItemInput } from '../../lib/nft-transfer';
import { NftThumb } from './NftThumb';
import { Notice } from '../Notice';

interface WalletBalance {
  walletId: string;
  address: string;
  wei: string;
  formatted: string;
  error?: string;
}

/** A deliberately generous flat estimate per item: a transfer's real cost depends on the receiver. */
const ROUGH_GAS_PER_ITEM = 100_000n;

export function TransferReviewStep({
  chainId,
  symbol,
  items,
  sourceWallets,
  destination,
  onDestinationChange,
  confirming,
  onBack,
  onConfirm,
}: {
  chainId: number;
  symbol: string;
  items: readonly NftTransferItemInput[];
  sourceWallets: readonly { id: string; address: string; label: string | null }[];
  destination: string;
  onDestinationChange: (value: string) => void;
  confirming: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { data: gasPrice } = useQuery({
    queryKey: ['gas-price', chainId],
    queryFn: () => apiRequest<{ gasPriceWei: string }>(`/chains/${chainId}/gas-price`),
    staleTime: 15_000,
  });
  const { data: balancesData } = useQuery({
    queryKey: ['wallets-balances', chainId],
    queryFn: () => apiRequest<{ balances: WalletBalance[] }>(`/wallets/balances?chainId=${chainId}`),
    staleTime: 15_000,
  });

  const destCheck = destination.trim() === '' ? null : checkAddress(destination);
  const isSourceWallet = destCheck?.ok && sourceWallets.some((w) => sameAddress(w.address, destCheck.address));

  const itemsByWallet = new Map<string, NftTransferItemInput[]>();
  for (const item of items) {
    const list = itemsByWallet.get(item.walletId);
    if (list) list.push(item);
    else itemsByWallet.set(item.walletId, [item]);
  }

  const balanceFor = (walletId: string) => balancesData?.balances.find((b) => b.walletId === walletId);
  const gasNeededWei = gasPrice ? BigInt(gasPrice.gasPriceWei) * ROUGH_GAS_PER_ITEM : null;

  const insufficientWallets = [...itemsByWallet.keys()].filter((walletId) => {
    const count = itemsByWallet.get(walletId)!.length;
    const balance = balanceFor(walletId);
    if (!gasNeededWei || !balance || balance.error) return false;
    return BigInt(balance.wei) < gasNeededWei * BigInt(count);
  });

  const destinationValid = destCheck?.ok === true && !isSourceWallet;
  const canConfirm = destinationValid && items.length > 0 && !confirming;

  return (
    <div>
      <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--stryx-sub)' }}>Destination address</label>
      <input
        className="mono"
        style={{ width: '100%', marginBottom: 4 }}
        value={destination}
        onChange={(e) => onDestinationChange(e.target.value)}
        placeholder="0x…"
        autoFocus
      />
      {destCheck && !destCheck.ok && <Notice tone="error">{addressProblemText(destCheck.problem)}</Notice>}
      {isSourceWallet && <Notice tone="error">Destination cannot be one of the source wallets.</Notice>}

      <p style={{ fontSize: 12.5, margin: '16px 0 8px' }}>
        {items.length} item{items.length === 1 ? '' : 's'} from {itemsByWallet.size} wallet{itemsByWallet.size === 1 ? '' : 's'}.
      </p>

      <div className="stryx-scroll" style={{ border: '1px solid var(--dash-line-strong)', borderRadius: 'var(--radius)', maxHeight: 220, overflowY: 'auto', padding: 10 }}>
        {[...itemsByWallet.entries()].map(([walletId, walletItems]) => {
          const wallet = sourceWallets.find((w) => w.id === walletId);
          const insufficient = insufficientWallets.includes(walletId);
          return (
            <div key={walletId} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{wallet?.label ?? walletId}</span>
                {insufficient && <span className="tag tag--error">not enough {symbol} for gas</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {walletItems.map((item) => (
                  <NftThumb key={`${item.contract}:${item.tokenId}`} tokenId={item.tokenId} size={32} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p style={{ color: 'var(--stryx-sub)', fontSize: 12, margin: '8px 0 16px' }}>
        Estimated gas only, a generous guess per item: real cost depends on the destination. Nothing is sent until you confirm below.
      </p>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onBack} disabled={confirming}>
          Back
        </button>
        <button className="primary" onClick={onConfirm} disabled={!canConfirm}>
          {confirming ? 'Sending…' : `Send ${items.length} item${items.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
