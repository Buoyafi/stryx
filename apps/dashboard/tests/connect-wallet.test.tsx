// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string) => {
      if (path === '/chains') return { chains: [{ chainId: 1, name: 'Ethereum' }, { chainId: 137, name: 'Polygon' }] };
      throw new Error(`unexpected request in test: ${path}`);
    }),
  };
});

import { ConnectWallet } from '../src/components/connect-wallet/ConnectWallet';
import { createWalletConnectStore, type WalletConnectStore } from '../src/lib/wallet-connect-store';
import type { DiscoveredWallet, Eip1193Provider } from '../src/lib/wallet';

const ACCOUNT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

function fakeWallet(balanceWei = 10n ** 18n) {
  const provider: Eip1193Provider = {
    async request({ method }) {
      switch (method) {
        case 'eth_requestAccounts':
          return [ACCOUNT];
        case 'eth_chainId':
          return '0x1';
        case 'eth_getBalance':
          return `0x${balanceWei.toString(16)}`;
        default:
          throw { code: -32601, message: `unhandled ${method}` };
      }
    },
  };
  const discovered: DiscoveredWallet = { id: 'w1', name: 'MetaMask', provider };
  return { discovered };
}

async function connect(store: WalletConnectStore) {
  const { discovered } = fakeWallet();
  await act(async () => {
    await store.connect(discovered);
  });
}

function withQuery(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(cleanup);

describe('ConnectWallet, variant="sidebar"', () => {
  it('shows the disconnected pill by default', () => {
    render(withQuery(<ConnectWallet variant="sidebar" store={createWalletConnectStore()} />));
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
  });

  it('clicking the disconnected pill opens the wallet picker', () => {
    render(withQuery(<ConnectWallet variant="sidebar" store={createWalletConnectStore()} />));
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows the short address once connected, and clicking it opens the account menu', async () => {
    const store = createWalletConnectStore();
    render(withQuery(<ConnectWallet variant="sidebar" store={store} />));
    await connect(store);
    const pill = screen.getByRole('button', { name: /0x5aAe.*eAed/ });
    expect(pill).toBeTruthy();
    fireEvent.click(pill);
    expect(await screen.findByRole('menu')).toBeTruthy();
  });

  it('pressing the pill again closes the menu (it used to reopen it)', async () => {
    const store = createWalletConnectStore();
    render(withQuery(<ConnectWallet variant="sidebar" store={store} />));
    await connect(store);
    const pill = screen.getByRole('button', { name: /0x5aAe.*eAed/ });
    fireEvent.click(pill);
    expect(await screen.findByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(pill);
    fireEvent.click(pill);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('from the desktop sidebar (menuBeside) the menu opens over the page, outside the clipping rail', async () => {
    const store = createWalletConnectStore();
    const { container } = render(withQuery(<ConnectWallet variant="sidebar" menuBeside store={store} />));
    await connect(store);
    fireEvent.click(screen.getByRole('button', { name: /0x5aAe.*eAed/ }));
    const menu = await screen.findByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(menu.closest('.account-menu-beside')?.parentElement).toBe(document.body);
    expect(screen.getByRole('menuitem', { name: 'Disconnect' })).toBeTruthy();
  });

  it('"Use a different wallet" lets the connected one go and opens the wallet chooser', async () => {
    const store = createWalletConnectStore();
    render(withQuery(<ConnectWallet variant="sidebar" store={store} />));
    await connect(store);
    fireEvent.click(screen.getByRole('button', { name: /0x5aAe.*eAed/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Use a different wallet' }));
    expect(store.getSnapshot().status).toBe('disconnected');
    expect(screen.getByRole('dialog', { name: 'Connect to Stryx' })).toBeTruthy();
  });
});

describe('ConnectWallet, variant="card"', () => {
  it('shows the "connect to disperse" empty state by default', () => {
    render(withQuery(<ConnectWallet variant="card" store={createWalletConnectStore()} />));
    expect(screen.getByText('Connect a wallet to disperse')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
  });

  it('shows the wallet name and short address once connected', async () => {
    const store = createWalletConnectStore();
    render(withQuery(<ConnectWallet variant="card" store={store} />));
    await connect(store);
    expect(screen.getByText('MetaMask')).toBeTruthy();
    expect(screen.getByText(/0x5aAe.*eAed/)).toBeTruthy();
  });

  it('shows the balance only once the wallet is actually on the requested chain', async () => {
    const store = createWalletConnectStore();
    const { rerender } = render(withQuery(<ConnectWallet variant="card" chainId={137} symbol="MATIC" store={store} />));
    await connect(store); // connects on chain 1
    // Wrong chain: no balance shown yet.
    expect(screen.queryByText(/MATIC/)).toBeNull();

    rerender(withQuery(<ConnectWallet variant="card" chainId={1} symbol="ETH" store={store} />));
    expect(await screen.findByText(/ETH/)).toBeTruthy();
  });

  it('reopens the same account menu the sidebar pill uses when "Change wallet" is clicked', async () => {
    const store = createWalletConnectStore();
    render(withQuery(<ConnectWallet variant="card" store={store} />));
    await connect(store);
    fireEvent.click(screen.getByRole('button', { name: 'Change wallet' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
  });
});

describe('ConnectWallet: shared state', () => {
  it('a sidebar instance and a card instance on the same store reflect one connection', async () => {
    const store = createWalletConnectStore();
    render(
      withQuery(
        <>
          <ConnectWallet variant="sidebar" store={store} />
          <ConnectWallet variant="card" store={store} />
        </>,
      ),
    );
    await connect(store);
    expect(screen.getAllByText(/0x5aAe.*eAed/).length).toBeGreaterThanOrEqual(2);

    await act(async () => store.disconnect());
    expect(screen.getAllByRole('button', { name: 'Connect wallet' })).toHaveLength(2);
  });
});
