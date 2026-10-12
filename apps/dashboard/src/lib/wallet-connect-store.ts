import { useSyncExternalStore } from 'react';
import { toast } from '@stryx/toast-ui';
import { classifyWalletError, discoverWallets, WalletError, WalletSession, type DiscoveredWallet, type Eip1193Provider } from './wallet';

export type WalletConnectStatus = 'disconnected' | 'connecting' | 'connected';

export interface WalletConnectState {
  status: WalletConnectStatus;
  /** The last discoverWallets() result, or null before the first discover(). */
  wallets: readonly DiscoveredWallet[] | null;
  session: WalletSession | null;
  account: string | null;
  walletName: string | null;
  walletIcon: string | undefined;
  chainId: number | null;
  error: string | null;
}

const CONNECT_TIMEOUT_MS = 60_000;

const INITIAL_STATE: WalletConnectState = {
  status: 'disconnected',
  wallets: null,
  session: null,
  account: null,
  walletName: null,
  walletIcon: undefined,
  chainId: null,
  error: null,
};

export interface WalletConnectStore {
  getSnapshot: () => WalletConnectState;
  subscribe: (listener: () => void) => () => void;
  discover: () => Promise<void>;
  connect: (wallet: DiscoveredWallet) => Promise<void>;
  disconnect: () => void;
  switchNetwork: (chainId: number) => Promise<void>;
  clearError: () => void;
}

/**
 * The operator's own browser wallet, shared by the sidebar's account pill and Disperse's source card:
 * connecting in one shows in the other.
 */
export function createWalletConnectStore(): WalletConnectStore {
  let state: WalletConnectState = INITIAL_STATE;
  const listeners = new Set<() => void>();
  let teardownProviderEvents: (() => void) | null = null;

  const commit = (next: WalletConnectState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  function disconnectInternal() {
    // A WalletConnect session lives on the phone too: end it there, not just here.
    void state.session?.provider.disconnect?.().catch(() => undefined);
    teardownProviderEvents?.();
    teardownProviderEvents = null;
    commit({ ...INITIAL_STATE, wallets: state.wallets });
  }

  // Keeps the store live when the account or network is changed in the wallet itself.
  function wireProviderEvents(provider: Eip1193Provider) {
    teardownProviderEvents?.();
    teardownProviderEvents = null;
    if (!provider.on) return;

    const onAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0];
      const account = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : undefined;
      if (!account) {
        disconnectInternal();
        return;
      }
      commit({ ...state, account });
    };
    const onChainChanged = (...args: unknown[]) => {
      const raw = args[0];
      const chainId = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
      if (Number.isFinite(chainId)) commit({ ...state, chainId });
    };
    const onDisconnect = () => disconnectInternal();

    provider.on('accountsChanged', onAccountsChanged);
    provider.on('chainChanged', onChainChanged);
    provider.on('disconnect', onDisconnect);
    teardownProviderEvents = () => {
      provider.removeListener?.('accountsChanged', onAccountsChanged);
      provider.removeListener?.('chainChanged', onChainChanged);
      provider.removeListener?.('disconnect', onDisconnect);
    };
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async discover() {
      const wallets = await discoverWallets();
      commit({ ...state, wallets });
    },

    async connect(wallet) {
      commit({ ...state, status: 'connecting', error: null });
      const session = new WalletSession(wallet.provider);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new WalletError('other', 'Your wallet did not respond. Check for a pending request and try again.')),
          CONNECT_TIMEOUT_MS,
        );
      });
      try {
        const [account] = await Promise.race([session.requestAccounts(), timeout]);
        clearTimeout(timeoutHandle);
        if (!account) throw new WalletError('other', 'The wallet returned no accounts.');
        const chainId = await session.chainId();
        wireProviderEvents(wallet.provider);
        commit({
          status: 'connected',
          wallets: state.wallets,
          session,
          account,
          walletName: wallet.name,
          walletIcon: wallet.icon,
          chainId,
          error: null,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        const message = classifyWalletError(err).message;
        commit({ ...state, status: 'disconnected', session: null, account: null, error: message });
        toast.error('Could not connect wallet', message);
      }
    },

    disconnect() {
      disconnectInternal();
    },

    async switchNetwork(chainId) {
      if (!state.session) return;
      try {
        await state.session.switchChain(chainId);
        commit({ ...state, chainId, error: null });
      } catch (err) {
        const message = classifyWalletError(err).message;
        commit({ ...state, error: message });
        toast.error('Could not switch network', message);
      }
    },

    clearError() {
      if (state.error !== null) commit({ ...state, error: null });
    },
  };
}

/** The one store the app uses. */
export const walletConnectStore: WalletConnectStore = createWalletConnectStore();

export function useConnectedWallet(store: WalletConnectStore = walletConnectStore): WalletConnectState & Omit<WalletConnectStore, 'getSnapshot' | 'subscribe'> {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    ...state,
    discover: store.discover,
    connect: store.connect,
    disconnect: store.disconnect,
    switchNetwork: store.switchNetwork,
    clearError: store.clearError,
  };
}
