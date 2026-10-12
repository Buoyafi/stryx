import { CHAINS } from '@stryx/chains';
import type { DiscoveredWallet, Eip1193Provider } from './wallet';

/**
 * WalletConnect (Reown): a wallet on the visitor's phone, reached by a QR code on desktop or a link
 * into the wallet app on a phone.
 */

export function walletConnectProjectId(env: Record<string, unknown> = import.meta.env as Record<string, unknown>): string | null {
  const id = String(env['VITE_WALLETCONNECT_PROJECT_ID'] ?? '').trim();
  return /^[0-9a-f]{32}$/i.test(id) ? id : null;
}

export const WALLETCONNECT_ID = 'walletconnect';

type Listener = (...args: unknown[]) => void;

interface LoadedProvider extends Eip1193Provider {
  on(event: string, listener: Listener): void;
  removeListener(event: string, listener: Listener): void;
  enable(): Promise<unknown>;
  disconnect(): Promise<void>;
  readonly connected: boolean;
}

/** A provider that loads WalletConnect on its first request. */
export function createLazyWalletConnectProvider(projectId: string, load: () => Promise<LoadedProvider> = () => initProvider(projectId)): Eip1193Provider & { disconnect(): Promise<void> } {
  let loading: Promise<LoadedProvider> | null = null;
  let provider: LoadedProvider | null = null;
  const pending: [string, Listener][] = [];
  const ready = () => {
    loading ??= load().then((p) => {
      provider = p;
      for (const [event, listener] of pending) p.on(event, listener);
      return p;
    });
    return loading;
  };
  return {
    async request(args) {
      const p = await ready();
      if (args.method === 'eth_requestAccounts' && !p.connected) await p.enable();
      return p.request(args);
    },
    on(event, listener) {
      if (provider) provider.on(event, listener);
      else pending.push([event, listener]);
    },
    removeListener(event, listener) {
      provider?.removeListener(event, listener);
      const i = pending.findIndex(([e, l]) => e === event && l === listener);
      if (i >= 0) pending.splice(i, 1);
    },
    async disconnect() {
      if (provider?.connected) await provider.disconnect();
    },
  };
}

async function initProvider(projectId: string): Promise<LoadedProvider> {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://stryx.app';
  // Testnets only in development: a production wallet prompt never lists a test network.
  const [first, ...rest] = CHAINS.filter((c) => !c.isTestnet || import.meta.env.DEV).map((c) => c.chainId);
  const provider = await EthereumProvider.init({
    projectId,
    showQrModal: true,
    // Every mainnet Stryx knows, all optional: the wallet connects on whichever it supports.
    optionalChains: [first!, ...rest],
    metadata: {
      name: 'Stryx',
      description: 'Mint NFT drops the moment they open.',
      url: origin,
      icons: [`${origin}/brand/favicon.svg`],
    },
  });
  return provider as unknown as LoadedProvider;
}

let shared: DiscoveredWallet | null = null;

/** The WalletConnect choice for the wallet chooser, or null when this build has no project ID. */
export function walletConnectOption(projectId: string | null = walletConnectProjectId()): DiscoveredWallet | null {
  if (!projectId) return null;
  shared ??= { id: WALLETCONNECT_ID, name: 'WalletConnect', provider: createLazyWalletConnectProvider(projectId) };
  return shared;
}
