// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const calls: { path: string; method?: string; body?: unknown }[] = [];
let responder: (path: string, method: string | undefined, body: unknown) => unknown = (path, method) => {
  throw new Error(`unexpected request in test: ${method ?? 'GET'} ${path}`);
};

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      calls.push({ path, method: options.method, body: options.body });
      return responder(path, options.method, options.body);
    }),
  };
});

import { NftTransferModal } from '../src/components/nft-transfer/NftTransferModal';

const CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890';
const WALLET_A = { id: 'w1', address: '0x1111111111111111111111111111111111111111', label: 'Alpha', status: 'ACTIVE' };

function renderModal(onCancel = () => {}, onTransferred = () => {}, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <NftTransferModal onCancel={onCancel} onTransferred={onTransferred} />
    </QueryClientProvider>,
  );
}

function defaultResponder(path: string, method: string | undefined) {
  if (path === '/chains') return { chains: [{ chainId: CHAIN_ID, name: 'Robinhood Chain Testnet' }] };
  if (path === '/wallets' && (method ?? 'GET') === 'GET') return [WALLET_A];
  if (path === `/wallets/${WALLET_A.id}/nfts?chainId=${CHAIN_ID}`) {
    return { walletId: WALLET_A.id, chainId: CHAIN_ID, source: 'ledger', holdings: [{ contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }] };
  }
  if (path === `/wallets/balances?chainId=${CHAIN_ID}`) {
    return { chainId: CHAIN_ID, balances: [{ walletId: WALLET_A.id, address: WALLET_A.address, wei: '1000000000000000000', formatted: '1' }] };
  }
  if (path === `/chains/${CHAIN_ID}/gas-price`) return { gasPriceWei: '10000000', fetchedAt: Date.now(), cached: false };
  throw new Error(`unexpected request in test: ${method} ${path}`);
}

beforeEach(() => {
  calls.length = 0;
  responder = defaultResponder;
});
afterEach(cleanup);

/** Opens the chain Dropdown and picks the option; findByRole retries until the /chains
 *  query has resolved and the option actually renders inside the now-open panel. */
async function selectChain() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Chain' }));
  // The Dropdown commits on mousedown (not click), to preempt the trigger losing focus.
  fireEvent.mouseDown(await screen.findByRole('option', { name: 'Robinhood Chain Testnet' }));
}

async function selectWalletAndToken() {
  await selectChain();
  fireEvent.click(await screen.findByText(/Alpha/));
  await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('checkbox')[1]!); // [0] is the wallet checkbox, [1] is the token
}

describe('NftTransferModal', () => {
  it('lists a selected wallet\'s holdings once a chain and wallet are chosen', async () => {
    renderModal();
    await selectChain();
    fireEvent.click(await screen.findByText(/Alpha/));

    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2));
    expect(calls.some((c) => c.path === `/wallets/${WALLET_A.id}/nfts?chainId=${CHAIN_ID}`)).toBe(true);
  });

  it('shows the "minted through Stryx only" label when the ledger, not a live indexer, answered', async () => {
    renderModal();
    await selectChain();
    fireEvent.click(await screen.findByText(/Alpha/));

    await screen.findByText('minted through Stryx only');
  });

  it('disables Review until at least one token is selected', async () => {
    renderModal();
    await selectChain();
    fireEvent.click(await screen.findByText(/Alpha/));
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2));

    expect((screen.getByRole('button', { name: /Review/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('selecting a token enables Review and moves to the review step', async () => {
    renderModal();
    await selectWalletAndToken();

    fireEvent.click(screen.getByRole('button', { name: /Review \(1\)/ }));

    await screen.findByText('Review transfer');
    expect(screen.getByText(/1 item from 1 wallet/)).toBeTruthy();
  });

  it('unticking a wallet unselects its tokens: what is hidden is never sent', async () => {
    renderModal();
    await selectWalletAndToken();
    expect(screen.getByRole('button', { name: /Review \(1\)/ })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('checkbox')[0]!); // untick the wallet
    expect((screen.getByRole('button', { name: /Review/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getAllByRole('checkbox')[0]!); // tick it again: nothing comes back selected
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2));
    expect((screen.getAllByRole('checkbox')[1] as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: /Review/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('rejects sending to one of the source wallets as the destination', async () => {
    renderModal();
    await selectWalletAndToken();
    fireEvent.click(screen.getByRole('button', { name: /Review \(1\)/ }));
    await screen.findByText('Review transfer');

    fireEvent.change(screen.getByPlaceholderText('0x…'), { target: { value: WALLET_A.address } });

    await screen.findByText('Destination cannot be one of the source wallets.');
    expect((screen.getByRole('button', { name: /Send 1 item/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the transfer and shows results on success', async () => {
    const onTransferred = vi.fn();
    responder = (path, method) => {
      if (path === '/wallets/nfts/transfer' && method === 'POST') {
        return {
          ok: true,
          results: [{ walletId: WALLET_A.id, contract: CONTRACT, tokenId: '1', standard: 'erc721', status: 'sent', hash: `0x${'aa'.repeat(32)}` }],
        };
      }
      return defaultResponder(path, method);
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderModal(() => {}, onTransferred, client);
    await selectWalletAndToken();
    fireEvent.click(screen.getByRole('button', { name: /Review \(1\)/ }));
    await screen.findByText('Review transfer');
    fireEvent.change(screen.getByPlaceholderText('0x…'), { target: { value: '0x2222222222222222222222222222222222222222' } });

    fireEvent.click(await screen.findByRole('button', { name: /Send 1 item/ }));

    await screen.findByText('Transfer results');
    await screen.findByText(/1\/1 item sent\./);
    expect(onTransferred).toHaveBeenCalledOnce();
    // The holdings list is read again next time, not served with the sent token still in it.
    expect(client.getQueryState(['nft-holdings', WALLET_A.id, CHAIN_ID])?.isInvalidated).toBe(true);
    const call = calls.find((c) => c.path === '/wallets/nfts/transfer');
    expect(call!.body).toMatchObject({ chainId: CHAIN_ID, destination: '0x2222222222222222222222222222222222222222' });
  });
});
