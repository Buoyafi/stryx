import { useEffect, useRef, type RefObject } from 'react';
import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';
import { chainById } from '@stryx/chains';
import { CopyableValue } from '../CopyableValue';
import { useConnectedWallet, walletConnectStore, type WalletConnectStore } from '../../lib/wallet-connect-store';

/**
 * Opens from either connected pill (sidebar or Disperse card): copy address, see the network the
 * wallet is on, use a different wallet, disconnect.
 */
export function AccountMenu({
  onClose,
  store = walletConnectStore,
  anchorRef,
  onChangeWallet,
}: {
  onClose: () => void;
  /** "Use a different wallet": the owner disconnects this one and opens the wallet chooser. */
  onChangeWallet?: () => void;
  store?: WalletConnectStore;
  /** The button that opens the menu: a press on it is left to its own toggle, not treated as outside. */
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const wallet = useConnectedWallet(store);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (anchorRef?.current?.contains(target)) return;
      if (rootRef.current && !rootRef.current.contains(target)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, anchorRef]);

  if (!wallet.account) return null;

  return (
    <div ref={rootRef} className="account-menu" role="menu">
      <div className="account-menu__row account-menu__row--static">
        <CopyableValue value={wallet.account} title={`Copy ${wallet.account}`} />
      </div>

      {wallet.chainId !== null && (
        <div className="account-menu__row account-menu__row--static account-menu__network">
          <ChainIcon chain={viewForChainId(wallet.chainId, chainById(wallet.chainId)?.name)} interactive={false} size="sm" />
          <span>On {chainById(wallet.chainId)?.name ?? `chain ${wallet.chainId}`}</span>
        </div>
      )}

      {onChangeWallet && (
        <button
          type="button"
          role="menuitem"
          className="account-menu__row"
          onClick={() => {
            onClose();
            onChangeWallet();
          }}
        >
          Use a different wallet
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="account-menu__row account-menu__row--danger"
        onClick={() => {
          wallet.disconnect();
          onClose();
        }}
      >
        Disconnect
      </button>
    </div>
  );
}
