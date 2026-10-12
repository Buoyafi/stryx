import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  useConnectedWallet,
  walletConnectStore,
  type WalletConnectStore,
} from '../../lib/wallet-connect-store';
import type { DiscoveredWallet } from '../../lib/wallet';
import { walletConnectOption } from '../../lib/walletconnect';
import {
  MORE_WALLETS,
  WALLETCONNECT_LOGO,
  knownWallet,
  walletLogoUrl,
} from '../../lib/wallet-logos';
import { WORDMARK_HTML } from '../../lib/brand-svg';

function focusableIn(el: HTMLElement | null): HTMLElement[] {
  if (!el) return [];
  return [
    ...el.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

/** The shared wallet picker: bottom sheet on mobile, centred modal on desktop. */
export function WalletPickerModal({
  onClose,
  triggerRef,
  store = walletConnectStore,
  onPick,
  title = 'Choose the wallet to use.',
}: {
  onClose: () => void;
  /** Focus returns here when the picker closes. */
  triggerRef: React.RefObject<HTMLElement | null>;
  store?: WalletConnectStore;
  /** Choose-only mode: called with the picked wallet instead of connecting it here. */
  onPick?: (wallet: DiscoveredWallet) => void;
  /** The line under "Connect to Stryx": what the wallet is for. */
  title?: string;
}) {
  const wallet = useConnectedWallet(store);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void wallet.discover();
    // Fresh every time the picker opens, in case a wallet was installed since the last look.
  }, []);

  useEffect(() => {
    focusableIn(dialogRef.current)[0]?.focus();
    return () => {
      triggerRef.current?.focus?.();
    };
    // Mount-only on purpose (empty deps).
  }, []);

  // Connect mode closes once a wallet is connected.
  useEffect(() => {
    if (!onPick && wallet.status === 'connected') onClose();
  }, [wallet.status, onClose, onPick]);

  function requestClose() {
    // Reopening the picker never shows a stale "waiting" state.
    if (wallet.status === 'connecting') wallet.disconnect();
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = focusableIn(dialogRef.current);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const connecting = !onPick && wallet.status === 'connecting';
  const phone = walletConnectOption();
  // Wallets to install: the known ones not already found in this browser.
  const detected = new Set((wallet.wallets ?? []).map((w) => knownWallet(w)?.key));
  const more = MORE_WALLETS.filter((w) => !detected.has(w.key));

  return createPortal(
    <div className="wallet-picker-backdrop" onClick={requestClose}>
      <div
        ref={dialogRef}
        className="wallet-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-picker-title"
        aria-describedby="wallet-picker-sub"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="wallet-picker__head">
          {/* "Connect to" and the Stryx wordmark itself (the logo is never re-typeset in a font). */}
          <h2 id="wallet-picker-title" className="wallet-picker__title">
            <span className="wallet-picker__title-lead">Connect to</span>
            <span className="sr-only"> Stryx</span>
            <span
              className="wallet-picker__wordmark"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: WORDMARK_HTML }}
            />
          </h2>
          <p id="wallet-picker-sub" className="wallet-picker__sub">
            {title}
          </p>
          <button
            type="button"
            className="wallet-picker__close"
            aria-label="Close"
            onClick={requestClose}
          >
            &#x2715;
          </button>
        </div>

        {connecting ? (
          <div className="wallet-picker__waiting">
            <span className="wallet-picker__spinner" aria-hidden="true" />
            <p>Approve in your wallet</p>
          </div>
        ) : (
          <>
            <div className="wallet-picker__section">
              <div className="wallet-picker__section-label">Detected</div>
              {wallet.wallets === null ? (
                <p className="wallet-picker__hint">Looking for wallets in this browser…</p>
              ) : wallet.wallets.length === 0 ? (
                <p className="wallet-picker__hint">
                  No wallet detected in this browser yet. Install one below, or open this page in
                  your wallet app's browser.
                </p>
              ) : (
                wallet.wallets.map((w) => {
                  // The wallet's own announced icon first, else the logo we hold for it.
                  const known = knownWallet(w);
                  const logo = w.icon ?? (known ? walletLogoUrl(known.key) : null);
                  return (
                    <button
                      key={w.id}
                      type="button"
                      className="wallet-picker__row"
                      onClick={() => (onPick ? onPick(w) : void wallet.connect(w))}
                    >
                      {logo ? (
                        <img src={logo} alt="" width={28} height={28} />
                      ) : (
                        <span className="wallet-picker__row-fallback" aria-hidden="true">
                          {w.name.slice(0, 1)}
                        </span>
                      )}
                      <span className="wallet-picker__row-name">{w.name}</span>
                      <span className="wallet-picker__tag">Detected</span>
                    </button>
                  );
                })
              )}
            </div>

            {phone && (
              <div className="wallet-picker__section">
                <div className="wallet-picker__section-label">Phone wallet</div>
                <button
                  type="button"
                  className="wallet-picker__row"
                  onClick={() => (onPick ? onPick(phone) : void wallet.connect(phone))}
                >
                  <img src={WALLETCONNECT_LOGO} alt="" width={28} height={28} />
                  <span className="wallet-picker__row-name">
                    WalletConnect
                    <small className="wallet-picker__row-sub">
                      MetaMask, Rainbow, Trust and more on your phone
                    </small>
                  </span>
                  <span className="wallet-picker__tag">Scan</span>
                </button>
              </div>
            )}

            {more.length > 0 && (
              <div className="wallet-picker__section">
                <div className="wallet-picker__section-label">More wallets</div>
                {more.map((w) => (
                  <a
                    key={w.key}
                    href={w.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="wallet-picker__row"
                  >
                    <img src={walletLogoUrl(w.key)} alt="" width={28} height={28} />
                    <span className="wallet-picker__row-name">{w.name}</span>
                    <span className="wallet-picker__get">Get</span>
                  </a>
                ))}
              </div>
            )}
          </>
        )}

        <p className="wallet-picker__footer">Stryx never sees your private keys.</p>
      </div>
    </div>,
    document.body,
  );
}
