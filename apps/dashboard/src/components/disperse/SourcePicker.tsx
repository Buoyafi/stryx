import { WalletPicker } from '../WalletPicker';
import { ConnectWallet } from '../connect-wallet/ConnectWallet';
import type { WalletConnectStore } from '../../lib/wallet-connect-store';

export interface OurWallet {
  id: string;
  address: string;
  label: string | null;
  tier: string;
  status: string;
}

export type SourceKind = 'connected' | 'ours';

/**
 * Where the funds come from: a wallet connected in this browser (the user signs in their own wallet;
 * Stryx never sees a key), or, on the operator dashboard only, one of Stryx's own wallets.
 */
export function SourcePicker(props: {
  mode: 'operator' | 'user';
  kind: SourceKind;
  onKind: (k: SourceKind) => void;
  store?: WalletConnectStore;
  chainId: number | null;
  symbol: string;
  ourWallets: readonly OurWallet[];
  ourId: string;
  onOurChange: (id: string) => void;
}) {
  const { mode, kind } = props;
  return (
    <div>
      {mode === 'operator' && (
        <div className="segmented segmented--quiet" role="radiogroup" aria-label="Source" style={{ marginBottom: 12 }}>
          {(['connected', 'ours'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} tabIndex={kind === k ? 0 : -1} className={`segmented__option${kind === k ? ' is-selected' : ''}`} onClick={() => props.onKind(k)}>
              {k === 'connected' ? 'Connected wallet' : 'Stryx wallet'}
            </button>
          ))}
        </div>
      )}

      {kind === 'connected' && <ConnectWallet variant="card" chainId={props.chainId} symbol={props.symbol} store={props.store} />}

      {kind === 'ours' && mode === 'operator' && (
        <WalletPicker
          wallets={[...props.ourWallets]}
          chainId={props.chainId === null ? '' : String(props.chainId)}
          selectedId={props.ourId}
          onSelect={props.onOurChange}
        />
      )}
    </div>
  );
}
