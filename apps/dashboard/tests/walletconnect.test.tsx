// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createLazyWalletConnectProvider, walletConnectProjectId } from '../src/lib/walletconnect';
import { WalletPickerModal } from '../src/components/connect-wallet/WalletPickerModal';
import { createWalletConnectStore } from '../src/lib/wallet-connect-store';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

function fakeProvider() {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const calls: string[] = [];
  const p = {
    connected: false,
    calls,
    listeners,
    async enable() {
      calls.push('enable (QR shown)');
      p.connected = true;
      return ['0xabc'];
    },
    async request({ method }: { method: string }) {
      calls.push(method);
      return method === 'eth_requestAccounts' ? ['0xabc'] : '0x1';
    },
    on(e: string, l: (...a: unknown[]) => void) {
      listeners.set(e, [...(listeners.get(e) ?? []), l]);
    },
    removeListener(e: string, l: (...a: unknown[]) => void) {
      listeners.set(e, (listeners.get(e) ?? []).filter((x) => x !== l));
    },
    async disconnect() {
      calls.push('disconnect');
      p.connected = false;
    },
  };
  return p;
}

describe('WalletConnect', () => {
  it('reads the project ID from the build, and ignores anything that is not one', () => {
    expect(walletConnectProjectId({ VITE_WALLETCONNECT_PROJECT_ID: '639b2f8b77e751b10b1d19d910850109' })).toBe('639b2f8b77e751b10b1d19d910850109');
    expect(walletConnectProjectId({ VITE_WALLETCONNECT_PROJECT_ID: ' 639B2F8B77E751B10B1D19D910850109 ' })).toBe('639B2F8B77E751B10B1D19D910850109');
    expect(walletConnectProjectId({})).toBeNull();
    expect(walletConnectProjectId({ VITE_WALLETCONNECT_PROJECT_ID: 'not-an-id' })).toBeNull();
  });

  it('loads nothing until used; asking for accounts shows the QR once; events wired early still arrive', async () => {
    const real = fakeProvider();
    const load = vi.fn(async () => real);
    const lazy = createLazyWalletConnectProvider('x'.repeat(32), load);
    const onAccounts = vi.fn();
    lazy.on!('accountsChanged', onAccounts);
    expect(load).not.toHaveBeenCalled(); // nothing downloaded on page load
    expect(await lazy.request({ method: 'eth_requestAccounts' })).toEqual(['0xabc']);
    await lazy.request({ method: 'eth_requestAccounts' });
    await lazy.request({ method: 'eth_chainId' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(real.calls).toEqual(['enable (QR shown)', 'eth_requestAccounts', 'eth_requestAccounts', 'eth_chainId']);
    real.listeners.get('accountsChanged')![0]!(['0xdef']);
    expect(onAccounts).toHaveBeenCalledWith(['0xdef']);
    await lazy.disconnect();
    expect(real.calls.at(-1)).toBe('disconnect');
  });

  it('the wallet chooser offers it only when the build has a project ID', () => {
    const store = createWalletConnectStore();
    const ref = { current: null };
    const { unmount } = render(<WalletPickerModal onClose={() => {}} triggerRef={ref} store={store} />);
    expect(screen.queryByText('Phone wallet')).toBeNull();
    unmount();

    vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '639b2f8b77e751b10b1d19d910850109');
    const onPick = vi.fn();
    render(<WalletPickerModal onClose={() => {}} triggerRef={ref} store={store} onPick={onPick} title="Sign in with your wallet" />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Phone wallet')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /WalletConnect/ }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'walletconnect', name: 'WalletConnect' }));
  });
});
