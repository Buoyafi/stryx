// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@stryx/toast-ui', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() } }));

import { toast } from '@stryx/toast-ui';
import type { DiscoveredWallet, Eip1193Provider } from '../src/lib/wallet';
import { createWalletConnectStore, type WalletConnectStore } from '../src/lib/wallet-connect-store';

/** A scripted wallet: each RPC method is a handler, and it can emit EIP-1193 provider events. */
function fakeWallet(handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      const h = handlers[method];
      if (!h) throw { code: -32601, message: `unhandled ${method}` };
      return h(params);
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const l of [...(listeners.get(event) ?? [])]) l(...args);
  };
  const listenerCount = (event: string) => listeners.get(event)?.size ?? 0;
  return { provider, emit, listenerCount };
}

const ACCOUNT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const OTHER_ACCOUNT = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

function discovered(provider: Eip1193Provider, overrides: Partial<DiscoveredWallet> = {}): DiscoveredWallet {
  return { id: 'w1', name: 'MetaMask', icon: 'data:image/svg+xml;base64,AAAA', provider, ...overrides };
}

describe('walletConnectStore', () => {
  let store: WalletConnectStore;

  beforeEach(() => {
    store = createWalletConnectStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect() succeeds: reads the account and chain, and wires provider events', async () => {
    const { provider, listenerCount } = fakeWallet({
      eth_requestAccounts: () => [ACCOUNT],
      eth_chainId: () => '0x1',
    });
    await store.connect(discovered(provider));
    const state = store.getSnapshot();
    expect(state.status).toBe('connected');
    expect(state.account).toBe(ACCOUNT);
    expect(state.chainId).toBe(1);
    expect(state.walletName).toBe('MetaMask');
    expect(state.error).toBeNull();
    expect(listenerCount('accountsChanged')).toBe(1);
  });

  it('connect() rejection surfaces a clear, classified message and leaves the store disconnected', async () => {
    const { provider } = fakeWallet({
      eth_requestAccounts: () => {
        throw { code: 4001, message: 'User rejected the request.' };
      },
    });
    await store.connect(discovered(provider));
    const state = store.getSnapshot();
    expect(state.status).toBe('disconnected');
    expect(state.session).toBeNull();
    expect(state.error).toBe('You rejected the request in your wallet.');
    // Errors are a toast, like every other system event.
    expect(toast.error).toHaveBeenCalledWith('Could not connect wallet', 'You rejected the request in your wallet.');
  });

  it('connect() times out with a clear message if the wallet never responds', async () => {
    vi.useFakeTimers();
    const hang = new Promise<never>(() => {}); // never resolves, simulating a stuck wallet
    const { provider } = fakeWallet({ eth_requestAccounts: () => hang });
    const connectPromise = store.connect(discovered(provider));
    await vi.advanceTimersByTimeAsync(60_000);
    await connectPromise;
    const state = store.getSnapshot();
    expect(state.status).toBe('disconnected');
    expect(state.error).toMatch(/did not respond/);
    expect(toast.error).toHaveBeenCalledWith('Could not connect wallet', expect.stringMatching(/did not respond/));
  });

  it('disconnect() clears the session and stops listening to the provider', async () => {
    const { provider, listenerCount } = fakeWallet({ eth_requestAccounts: () => [ACCOUNT], eth_chainId: () => '0x1' });
    await store.connect(discovered(provider));
    store.disconnect();
    const state = store.getSnapshot();
    expect(state.status).toBe('disconnected');
    expect(state.session).toBeNull();
    expect(state.account).toBeNull();
    expect(listenerCount('accountsChanged')).toBe(0);
  });

  it('a live accountsChanged event updates the connected account without a reconnect', async () => {
    const { provider, emit } = fakeWallet({ eth_requestAccounts: () => [ACCOUNT], eth_chainId: () => '0x1' });
    await store.connect(discovered(provider));
    emit('accountsChanged', [OTHER_ACCOUNT]);
    expect(store.getSnapshot().account).toBe(OTHER_ACCOUNT);
  });

  it('an accountsChanged event with no accounts is treated as a disconnect', async () => {
    const { provider, emit } = fakeWallet({ eth_requestAccounts: () => [ACCOUNT], eth_chainId: () => '0x1' });
    await store.connect(discovered(provider));
    emit('accountsChanged', []);
    expect(store.getSnapshot().status).toBe('disconnected');
  });

  it('a live chainChanged event updates the chain id', async () => {
    const { provider, emit } = fakeWallet({ eth_requestAccounts: () => [ACCOUNT], eth_chainId: () => '0x1' });
    await store.connect(discovered(provider));
    emit('chainChanged', '0x89');
    expect(store.getSnapshot().chainId).toBe(137);
  });

  it('a provider-initiated disconnect event clears the store', async () => {
    const { provider, emit } = fakeWallet({ eth_requestAccounts: () => [ACCOUNT], eth_chainId: () => '0x1' });
    await store.connect(discovered(provider));
    emit('disconnect');
    expect(store.getSnapshot().status).toBe('disconnected');
  });

  it('switchNetwork() calls wallet_switchEthereumChain and updates the chain id on success', async () => {
    const calls: unknown[] = [];
    const { provider } = fakeWallet({
      eth_requestAccounts: () => [ACCOUNT],
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: (params) => {
        calls.push(params);
      },
    });
    await store.connect(discovered(provider));
    await store.switchNetwork(137);
    expect(calls).toEqual([[{ chainId: '0x89' }]]);
    expect(store.getSnapshot().chainId).toBe(137);
  });

  it('switchNetwork() records a classified error and leaves the chain id unchanged on failure', async () => {
    const { provider } = fakeWallet({
      eth_requestAccounts: () => [ACCOUNT],
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        throw { code: 4902, message: 'Unrecognized chain.' };
      },
    });
    await store.connect(discovered(provider));
    vi.clearAllMocks(); // clear the connect-success toast noise before asserting on switchNetwork's own
    await store.switchNetwork(137);
    const state = store.getSnapshot();
    expect(state.chainId).toBe(1);
    expect(state.error).toMatch(/does not have this network/);
    // A toast is what makes this failure visible once the account menu has closed.
    expect(toast.error).toHaveBeenCalledWith('Could not switch network', expect.stringMatching(/does not have this network/));
  });

  it('switchNetwork() is a no-op when nothing is connected', async () => {
    await store.switchNetwork(137);
    expect(store.getSnapshot().status).toBe('disconnected');
  });

  it('discover() populates wallets from a real EIP-6963 announcement on window', async () => {
    const { provider } = fakeWallet({});
    const onAnnounce = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: { info: { uuid: 'x', name: 'Rabby' }, provider },
        }),
      );
      window.removeEventListener('eip6963:requestProvider', onAnnounce);
    };
    window.addEventListener('eip6963:requestProvider', onAnnounce);
    await store.discover();
    expect(store.getSnapshot().wallets?.map((w) => w.name)).toEqual(['Rabby']);
  });

  it('clearError() resets a stale error without touching the rest of the state', async () => {
    const { provider } = fakeWallet({
      eth_requestAccounts: () => {
        throw { code: 4001, message: 'rejected' };
      },
    });
    await store.connect(discovered(provider));
    expect(store.getSnapshot().error).not.toBeNull();
    store.clearError();
    expect(store.getSnapshot().error).toBeNull();
  });
});
