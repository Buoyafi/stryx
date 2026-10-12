// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';

vi.mock('@stryx/toast-ui', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() } }));

import { toast } from '@stryx/toast-ui';
import { WalletPickerModal } from '../src/components/connect-wallet/WalletPickerModal';
import { createWalletConnectStore, type WalletConnectStore } from '../src/lib/wallet-connect-store';
import type { DiscoveredWallet, Eip1193Provider } from '../src/lib/wallet';

const ACCOUNT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

function fakeWindow(discovered: DiscoveredWallet[]) {
  const listeners = new Set<(e: Event) => void>();
  return {
    addEventListener: (_t: string, l: (e: Event) => void) => void listeners.add(l),
    removeEventListener: (_t: string, l: (e: Event) => void) => void listeners.delete(l),
    dispatchEvent: (e: Event) => {
      if (e.type === 'eip6963:requestProvider') {
        for (const w of discovered) {
          for (const l of [...listeners]) l(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: w.id, name: w.name }, provider: w.provider } }));
        }
      }
      return true;
    },
  };
}

function scriptedProvider(opts: { reject?: boolean } = {}) {
  let resolveRequest: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });
  const provider: Eip1193Provider = {
    async request({ method }) {
      if (method === 'eth_requestAccounts') {
        await gate;
        if (opts.reject) throw { code: 4001, message: 'User rejected the request.' };
        return [ACCOUNT];
      }
      if (method === 'eth_chainId') return '0x1';
      throw { code: -32601, message: `unhandled ${method}` };
    },
  };
  return { provider, release: () => resolveRequest?.() };
}

function setup(store: WalletConnectStore, discovered: DiscoveredWallet[] = []) {
  // Discovery uses the real global `window`, so mock its EIP-6963 handshake per test.
  const original = { addEventListener: window.addEventListener, removeEventListener: window.removeEventListener, dispatchEvent: window.dispatchEvent };
  const fake = fakeWindow(discovered);
  window.addEventListener = fake.addEventListener as typeof window.addEventListener;
  window.removeEventListener = fake.removeEventListener as typeof window.removeEventListener;
  window.dispatchEvent = fake.dispatchEvent as typeof window.dispatchEvent;

  const triggerRef = createRef<HTMLButtonElement>();
  document.body.innerHTML = '<button id="ext-trigger">trigger</button>';
  (triggerRef as { current: HTMLButtonElement | null }).current = document.getElementById('ext-trigger') as HTMLButtonElement;

  const onClose = () => {
    // simulates the parent unmounting the modal
    utils.rerender(<></>);
  };
  const utils = render(<WalletPickerModal onClose={onClose} triggerRef={triggerRef} store={store} />);

  return {
    ...utils,
    triggerRef,
    restore: () => {
      window.addEventListener = original.addEventListener;
      window.removeEventListener = original.removeEventListener;
      window.dispatchEvent = original.dispatchEvent;
    },
  };
}

afterEach(cleanup);

describe('WalletPickerModal', () => {
  it('is a labelled dialog', async () => {
    const store = createWalletConnectStore();
    const { restore } = setup(store);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('wallet-picker-title');
    restore();
  });

  it('is headed "Connect to Stryx", with the wordmark, and says what the wallet is for', () => {
    const { restore } = setup(createWalletConnectStore());
    const dialog = screen.getByRole('dialog', { name: 'Connect to Stryx' });
    expect(dialog.querySelector('.wallet-picker__wordmark svg')).not.toBeNull();
    expect(dialog.getAttribute('aria-describedby')).toBe('wallet-picker-sub');
    expect(screen.getByText('Choose the wallet to use.')).toBeTruthy();
    restore();
  });

  it('shows each wallet with its logo, and does not offer to install a wallet already detected', async () => {
    const { provider } = scriptedProvider();
    const { restore } = setup(createWalletConnectStore(), [{ id: 'r', name: 'Rabby', provider }]);
    const rabby = await screen.findByRole('button', { name: /Rabby/ });
    expect(rabby.querySelector('img')?.getAttribute('src')).toBe('/wallets/rabby.svg');
    expect(screen.queryByRole('link', { name: /Rabby/ })).toBeNull();
    expect(screen.getByRole('link', { name: /MetaMask/ }).querySelector('img')?.getAttribute('src')).toBe('/wallets/metamask.svg');
    restore();
  });

  it('lists a detected wallet under Detected, tagged as such, and lists the curated More-wallets links', async () => {
    const { provider } = scriptedProvider();
    const store = createWalletConnectStore();
    const { restore } = setup(store, [{ id: 'w1', name: 'Zerion', provider }]);
    expect(await screen.findByText('Zerion')).toBeTruthy();
    // "Detected" appears twice by design: the section label and the row's own tag.
    expect(screen.getAllByText('Detected')).toHaveLength(2);
    expect(screen.getByText('More wallets')).toBeTruthy();
    const metamaskLink = screen.getByRole('link', { name: /MetaMask/ });
    expect(metamaskLink.getAttribute('href')).toBe('https://metamask.io');
    expect(metamaskLink.getAttribute('target')).toBe('_blank');
    restore();
  });

  it('clicking a detected wallet shows the waiting state, then closes once connected', async () => {
    const { provider, release } = scriptedProvider();
    const store = createWalletConnectStore();
    const { restore } = setup(store, [{ id: 'w1', name: 'Zerion', provider }]);
    fireEvent.click(await screen.findByRole('button', { name: /Zerion/ }));
    expect(await screen.findByText('Approve in your wallet')).toBeTruthy();

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(store.getSnapshot().status).toBe('connected'));
    restore();
  });

  it('shows a clear message when the wallet rejects the request, as a toast (the shared error design, not a one-off inline box)', async () => {
    const { provider, release } = scriptedProvider({ reject: true });
    const store = createWalletConnectStore();
    const { restore } = setup(store, [{ id: 'w1', name: 'Zerion', provider }]);
    fireEvent.click(await screen.findByRole('button', { name: /Zerion/ }));
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not connect wallet', 'You rejected the request in your wallet.'));
    // The picker itself returns to its idle list, ready for another attempt, rather
    // than duplicating the error inline.
    expect(await screen.findByRole('button', { name: /Zerion/ })).toBeTruthy();
    restore();
  });

  it('Escape closes the picker and, while connecting, cancels it (no stale waiting state on reopen)', async () => {
    const { provider } = scriptedProvider(); // never released: stays "connecting"
    const store = createWalletConnectStore();
    const { restore } = setup(store, [{ id: 'w1', name: 'Zerion', provider }]);
    fireEvent.click(await screen.findByRole('button', { name: /Zerion/ }));
    await screen.findByText('Approve in your wallet');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(store.getSnapshot().status).toBe('disconnected');
    restore();
  });

  it('a click on the backdrop closes it', () => {
    const store = createWalletConnectStore();
    const { restore } = setup(store);
    const backdrop = document.querySelector('.wallet-picker-backdrop')!;
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
    restore();
  });

  it('covers the whole page: it is rendered at the body, outside whatever card opened it', () => {
    const store = createWalletConnectStore();
    const { restore, container } = setup(store);
    expect(container.querySelector('.wallet-picker-backdrop')).toBeNull();
    expect(document.querySelector('.wallet-picker-backdrop')!.parentElement).toBe(document.body);
    restore();
  });

  it('Tab on the last focusable row wraps to the first, and Shift+Tab on the first wraps to the last', async () => {
    const { provider } = scriptedProvider();
    const store = createWalletConnectStore();
    const { restore } = setup(store, [{ id: 'w1', name: 'Zerion', provider }]);
    await screen.findByText('Zerion');
    const dialog = screen.getByRole('dialog');
    const focusables = within(dialog).getAllByRole('button').concat(within(dialog).getAllByRole('link'));
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    last.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    restore();
  });

  it('moves focus into the dialog on open and back to the trigger on close', () => {
    const store = createWalletConnectStore();
    const { restore, triggerRef, unmount } = setup(store);
    expect(document.activeElement).not.toBe(triggerRef.current);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(triggerRef.current);
    restore();
  });
});
