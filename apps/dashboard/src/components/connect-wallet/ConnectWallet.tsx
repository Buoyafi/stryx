import { chainById } from '@stryx/chains';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatWei } from '../../lib/units';
import { WalletIcon } from '../../lib/icons';
import { AddressAvatar } from './AddressAvatar';
import { WalletPickerModal } from './WalletPickerModal';
import { AccountMenu } from './AccountMenu';
import { useConnectedWallet, walletConnectStore, type WalletConnectStore } from '../../lib/wallet-connect-store';

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The operator's own browser wallet: one component for the sidebar footer and Disperse's source card,
 * both reading the same connection.
 */
export function ConnectWallet({
  variant,
  /** Only for `variant="card"`: shows the native balance once the wallet is on this chain. */
  chainId = null,
  symbol,
  store = walletConnectStore,
  menuBeside = false,
}: {
  variant: 'sidebar' | 'card';
  chainId?: number | null;
  symbol?: string;
  store?: WalletConnectStore;
  /** Open the account menu beside the pill, over the page (the desktop sidebar clips anything inside it). */
  menuBeside?: boolean;
}) {
  const wallet = useConnectedWallet(store);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [beside, setBeside] = useState<{ left: number; bottom: number } | null>(null);

  // Beside the pill: bottom-aligned with it, just past the sidebar's edge, kept on screen.
  useLayoutEffect(() => {
    if (!menuBeside || !menuOpen || !triggerRef.current) return;
    const place = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      setBeside({ left: Math.max(8, Math.min(r.right + 14, window.innerWidth - 236)), bottom: Math.max(8, window.innerHeight - r.bottom) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [menuBeside, menuOpen]);

  // Discover wallets as soon as this mounts, so the picker's Detected section is ready.
  useEffect(() => {
    if (wallet.wallets === null) void wallet.discover();
    // Mount-only on purpose (empty deps).
  }, []);

  useEffect(() => {
    if (variant !== 'card' || !wallet.session || !wallet.account || chainId === null || wallet.chainId !== chainId) {
      setBalanceWei(null);
      return;
    }
    let live = true;
    wallet.session
      .balance(wallet.account)
      .then((wei) => live && setBalanceWei(wei))
      .catch(() => live && setBalanceWei(null));
    return () => {
      live = false;
    };
  }, [variant, wallet.session, wallet.account, wallet.chainId, chainId]);

  const connected = wallet.status === 'connected' && wallet.account !== null;
  // In the sidebar's collapsed rail the label hides like every other row's.
  const labelClass = variant === 'sidebar' ? 'sidebar__label' : undefined;

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={connected ? 'connect-pill connect-pill--connected' : 'connect-pill'}
      onClick={() => (connected ? setMenuOpen((v) => !v) : setPickerOpen(true))}
      aria-haspopup={connected ? 'menu' : 'dialog'}
      aria-expanded={connected ? menuOpen : pickerOpen}
    >
      {connected ? (
        <>
          <AddressAvatar address={wallet.account!} />
          <span className={`connect-pill__address${labelClass ? ` ${labelClass}` : ''}`}>{shortAddress(wallet.account!)}</span>
          <span className="connect-pill__dot" aria-hidden="true" title="Connected" />
        </>
      ) : (
        <>
          {/* The card variant sits below its own icon-in-a-circle, so the button doesn't repeat it. */}
          {variant === 'sidebar' && <WalletIcon aria-hidden />}
          <span className={labelClass}>Connect wallet</span>
        </>
      )}
    </button>
  );

  const picker = pickerOpen && <WalletPickerModal onClose={() => setPickerOpen(false)} triggerRef={triggerRef} store={store} />;
  const accountMenu = (
    <AccountMenu
      onClose={() => setMenuOpen(false)}
      store={store}
      anchorRef={triggerRef}
      onChangeWallet={() => {
        // The chooser closes itself while a wallet is connected, so let this one go first.
        wallet.disconnect();
        setPickerOpen(true);
      }}
    />
  );
  const menu =
    menuOpen &&
    (menuBeside
      ? beside &&
        createPortal(
          <div className="account-menu-beside" style={{ left: beside.left, bottom: beside.bottom }}>
            {accountMenu}
          </div>,
          document.body,
        )
      : <div className="account-menu-anchor">{accountMenu}</div>);

  if (variant === 'sidebar') {
    return (
      <div className="connect-wallet connect-wallet--sidebar">
        {trigger}
        {menu}
        {picker}
      </div>
    );
  }

  // The card variant.
  return (
    <div className="connect-wallet connect-wallet--card">
      <div className="connect-card">
        {connected ? (
          <>
            {/* Plain, no glow badge behind it: the glow is reserved for the empty state's icon. */}
            <AddressAvatar address={wallet.account!} size={48} />
            <div className="connect-card__name">{wallet.walletName ?? 'Browser wallet'}</div>
            <div className="connect-card__address mono">{shortAddress(wallet.account!)}</div>
            {balanceWei !== null && (
              <div className="connect-card__balance mono">
                {formatWei(balanceWei)} {symbol ?? (chainId !== null ? (chainById(chainId)?.nativeCurrency.symbol ?? '') : '')}
              </div>
            )}
            <button
              ref={triggerRef}
              type="button"
              className="connect-card__change"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              Change wallet
            </button>
          </>
        ) : (
          <>
            <span className="connect-card__badge">
              <WalletIcon aria-hidden className="connect-card__icon" />
            </span>
            <div className="connect-card__name">Connect a wallet to disperse</div>
            <p className="connect-card__subtitle">You approve everything in your own wallet. Stryx never sees your keys.</p>
            {trigger}
          </>
        )}
      </div>
      {menu}
      {picker}
    </div>
  );
}
