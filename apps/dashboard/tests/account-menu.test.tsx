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

import { AccountMenu } from '../src/components/connect-wallet/AccountMenu';
import { createWalletConnectStore, type WalletConnectStore } from '../src/lib/wallet-connect-store';
import type { DiscoveredWallet, Eip1193Provider } from '../src/lib/wallet';

const ACCOUNT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

function fakeWallet() {
  const calls: { method: string; params?: unknown }[] = [];
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case 'eth_requestAccounts':
          return [ACCOUNT];
        case 'eth_chainId':
          return '0x1';
        case 'wallet_switchEthereumChain':
          return null;
        default:
          throw { code: -32601, message: `unhandled ${method}` };
      }
    },
  };
  const discovered: DiscoveredWallet = { id: 'w1', name: 'MetaMask', provider };
  return { discovered, calls };
}

async function connect(store: WalletConnectStore) {
  const { discovered, calls } = fakeWallet();
  await act(async () => {
    await store.connect(discovered);
  });
  return calls;
}

function mount(store: WalletConnectStore, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <div>
        <button type="button">outside</button>
        <AccountMenu onClose={onClose} store={store} />
      </div>
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

afterEach(cleanup);

describe('AccountMenu', () => {
  it('renders nothing when nothing is connected', () => {
    const { container } = mount(createWalletConnectStore());
    expect(container.querySelector('.account-menu')).toBeNull();
  });

  it('shows a copy-address row and the network the wallet is on, with no list of networks to switch to', async () => {
    const store = createWalletConnectStore();
    await connect(store);
    mount(store);
    expect(await screen.findByText('On Ethereum')).toBeTruthy();
    expect(screen.queryByText(/Switch network/)).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Polygon/ })).toBeNull();
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Disconnect']);
  });

  it('"Use a different wallet" closes the menu and hands over to the owner', async () => {
    const store = createWalletConnectStore();
    await connect(store);
    const onClose = vi.fn();
    const onChangeWallet = vi.fn();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <AccountMenu onClose={onClose} store={store} onChangeWallet={onChangeWallet} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use a different wallet' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onChangeWallet).toHaveBeenCalledOnce();
  });

  it('Disconnect clears the store and closes the menu', async () => {
    const store = createWalletConnectStore();
    await connect(store);
    const { onClose } = mount(store);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
    expect(store.getSnapshot().status).toBe('disconnected');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on an outside click', async () => {
    const store = createWalletConnectStore();
    await connect(store);
    const { onClose } = mount(store);
    await screen.findByText('On Ethereum');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', async () => {
    const store = createWalletConnectStore();
    await connect(store);
    const { onClose } = mount(store);
    await screen.findByText('On Ethereum');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
