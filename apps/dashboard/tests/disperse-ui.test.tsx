// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const chargeMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/brand', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/brand')>()), chargeLogo: chargeMock }));

const calls: { path: string; method: string; body?: unknown }[] = [];
let disperseOutcome: () => unknown;
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ path, method, body: options.body });
      if (path.startsWith('/wallets/balances')) return { balances: OUR.map((w) => ({ walletId: w.id, address: w.address, wei: '5000000000000000000', formatted: '5' })) };
      if (/^\/wallets\/[^/]+\/balances$/.test(path)) return { balances: [{ chainId: 46630, chainName: 'Testnet', wei: '5000000000000000000', formatted: '5' }] };
      if (/^\/chains\/\d+\/gas-price$/.test(path)) return { gasPriceWei: '1000000000' };
      if (path === '/wallets/disperse' && method === 'POST') return disperseOutcome();
      if (/^\/chains\/\d+\/transactions\/receipts$/.test(path)) return { receipts: (options.body as { hashes: string[] }).hashes.map((hash) => ({ hash, status: 'success' })) };
      throw new Error(`unexpected request in test: ${method} ${path}`);
    }),
  };
});

import { Disperse } from '../src/components/disperse/Disperse';
import { toChecksumAddress } from '../src/lib/address';
import type { DiscoveredWallet } from '../src/lib/wallet';
import { createWalletConnectStore, type WalletConnectStore } from '../src/lib/wallet-connect-store';

const SOURCE = '0x' + 'a'.repeat(40);
const R1 = '0x' + '1'.repeat(40);
const R2 = '0x' + '2'.repeat(40);
const R3 = '0x' + '3'.repeat(40);
const CHAINS = [
  { chainId: 46630, name: 'Robinhood Chain Testnet' },
  { chainId: 1, name: 'Ethereum' },
];
const OUR = [
  { id: 'w1', address: '0x' + 'b'.repeat(40), label: 'Alpha', tier: 'HOT', status: 'ACTIVE' },
  { id: 'w2', address: '0x' + 'c'.repeat(40), label: 'Bravo', tier: 'HOT', status: 'ACTIVE' },
  { id: 'w3', address: '0x' + 'd'.repeat(40), label: 'Charlie', tier: 'HOT', status: 'ACTIVE' },
];

/** A scripted EIP-1193 wallet. Records every request so a test can prove what was (not) asked of it. */
function scriptedWallet(opts: { chainId?: number; balanceWei?: bigint; rejectFrom?: number } = {}) {
  const log: { method: string; params?: unknown }[] = [];
  let chain = opts.chainId ?? 46630;
  let sent = 0;
  const provider = {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
      log.push({ method, params });
      switch (method) {
        case 'eth_requestAccounts': return [SOURCE];
        case 'eth_chainId': return '0x' + chain.toString(16);
        case 'wallet_switchEthereumChain': chain = Number((params as { chainId: string }[])[0]!.chainId); return null;
        case 'eth_getBalance': return '0x' + (opts.balanceWei ?? 10n ** 19n).toString(16);
        case 'eth_gasPrice': return '0x' + (10n ** 9n).toString(16);
        case 'eth_estimateGas': return '0x' + (100_000).toString(16);
        case 'eth_getCode': return '0x6001600055';
        case 'eth_sendTransaction': {
          if (opts.rejectFrom !== undefined && sent >= opts.rejectFrom) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          sent++;
          return '0x' + sent.toString(16).padStart(64, '0');
        }
        case 'eth_getTransactionReceipt': return { status: '0x1' };
        default: throw new Error(`unexpected wallet call ${method}`);
      }
    }),
  };
  const discovered: DiscoveredWallet = { id: 'test', name: 'Test Wallet', icon: '', provider };
  return { provider, log, discovered, sends: () => log.filter((l) => l.method === 'eth_sendTransaction') };
}

function mount(props: Partial<React.ComponentProps<typeof Disperse>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = props.store ?? createWalletConnectStore();
  const utils = render(
    <QueryClientProvider client={qc}>
      <Disperse mode="operator" chains={CHAINS} ourWallets={OUR} {...props} store={store} />
    </QueryClientProvider>,
  );
  return { ...utils, store };
}

const pasteAddresses = (text: string) => {
  fireEvent.change(screen.getByLabelText(/Paste addresses/), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Add addresses' }));
};
/** Connects the given store's wallet directly (through the real store logic, exercised on
 *  its own in wallet-connect-store.test.ts), so each test does not have to click through the
 *  picker modal itself just to get a wallet connected before testing something else. */
async function connectOn(chainName: RegExp, store: WalletConnectStore, w: ReturnType<typeof scriptedWallet>) {
  fireEvent.click(screen.getByRole('radio', { name: chainName }));
  await act(async () => {
    await store.connect(w.discovered);
  });
}

beforeEach(() => {
  calls.length = 0;
  chargeMock.mockClear();
  disperseOutcome = () => ({ ok: true, results: [] });
});
afterEach(cleanup);

describe('Disperse: what each mode shows', () => {
  it('user mode has no "our wallets" anywhere: not rendered at all, rather than shown disabled', async () => {
    mount({ mode: 'user', ourWallets: OUR });
    await screen.findByRole('button', { name: 'Connect wallet' });
    expect(screen.queryByText('Stryx wallet')).toBeNull();
    expect(screen.queryByText('Stryx wallets')).toBeNull();
    expect(screen.queryByText('Alpha')).toBeNull();
    // the paste and CSV inputs are still there
    expect(screen.getByLabelText(/Paste addresses/)).toBeTruthy();
    expect(screen.getByLabelText(/Paste CSV/)).toBeTruthy();
  });

  it('operator mode offers our wallets as a source and as recipients', async () => {
    mount();
    expect(await screen.findByRole('radio', { name: 'Stryx wallet' })).toBeTruthy();
    expect(screen.getByText('Stryx wallets')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('shows the shared chain icon on every chain button', async () => {
    mount();
    for (const c of CHAINS) {
      const btn = screen.getByRole('radio', { name: new RegExp(c.name) });
      expect(btn.querySelector('svg, img, [data-chain-icon], .chain-icon')).not.toBeNull();
    }
  });
});

describe('Disperse: recipients are checked inline, and the source can never be a recipient', () => {
  it('flags a bad address, a duplicate and the source wallet on their own rows, and blocks Review', async () => {
    const w = scriptedWallet();
    const { store } = mount();
    await connectOn(/Robinhood Chain Testnet/, store, w);
    await screen.findByText(/Balance|Review/, undefined);
    pasteAddresses([R1, R1, 'not-an-address', SOURCE].join('\n'));
    const table = screen.getByRole('table', { name: 'Recipients' });
    expect(within(table).getAllByText(/Duplicate/).length).toBeGreaterThan(0);
    expect(within(table).getByText(/Not an address/)).toBeTruthy();
    expect(within(table).getByText(/source wallet.*cannot send to itself/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove duplicates' }));
    expect(within(table).queryAllByText(/Duplicate/).length).toBe(0);
  });

  it('a mixed-case address with a wrong checksum is rejected, not silently fixed', async () => {
    const w = scriptedWallet();
    const { store } = mount();
    await connectOn(/Robinhood Chain Testnet/, store, w);
    // the EIP-55 reference address with one letter's case flipped
    pasteAddresses('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    expect(within(screen.getByRole('table', { name: 'Recipients' })).getByText(/checksum/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('our source wallet is not offered as a recipient', async () => {
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Stryx wallet' }));
    fireEvent.click(screen.getByRole('radio', { name: /Robinhood Chain Testnet/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Select a wallet/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Alpha/ }));
    expect(screen.queryByRole('checkbox', { name: /Alpha/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Bravo/ })).toBeTruthy();
  });
});

describe('Disperse: summary, quick amounts and Select all', () => {
  it('quick amounts fill the amount field and the summary total follows the picked wallets', async () => {
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Stryx wallet' }));
    fireEvent.click(screen.getByRole('radio', { name: /Robinhood Chain Testnet/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Select a wallet/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Alpha/ }));
    fireEvent.click(screen.getByRole('button', { name: '0.05' }));
    expect((screen.getByLabelText('Amount each') as HTMLInputElement).value).toBe('0.05');
    const summary = screen.getByRole('complementary', { name: 'Summary' });
    expect(within(summary).getByLabelText('Total to send').textContent).toBe('0 ETH');
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(within(summary).getByLabelText('Total to send').textContent).toBe('0.1 ETH'); // Bravo + Charlie
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(within(summary).getByLabelText('Total to send').textContent).toBe('0 ETH');
  });
});

describe('Disperse: the signature warning comes before review', () => {
  it('on a chain with no verified contract, a connected wallet is told how many times it will sign', async () => {
    const w = scriptedWallet();
    const { store } = mount();
    await connectOn(/Robinhood Chain Testnet/, store, w);
    pasteAddresses([R1, R2, R3].join('\n'));
    const note = await screen.findByRole('note');
    expect(note.textContent).toBe("This chain sends one transaction per recipient. You'll sign 3 times.");
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
  });

  it('a contract whose deployed code does not match the pinned hash is not used, and plain transfers are announced', async () => {
    const w = scriptedWallet({ chainId: 1 });
    const { store } = mount();
    await connectOn(/Ethereum/, store, w);
    pasteAddresses([R1, R2].join('\n'));
    expect((await screen.findByRole('note')).textContent).toMatch(/sign 2 times/);
    expect(await screen.findByText(/not the code that was verified/)).toBeTruthy();
  });
});

describe('Disperse: nothing is signed until the explicit confirm', () => {
  async function toReview(w: ReturnType<typeof scriptedWallet>) {
    const { store } = mount();
    await connectOn(/Robinhood Chain Testnet/, store, w);
    fireEvent.change(screen.getByLabelText('Amount each'), { target: { value: '0.5' } });
    pasteAddresses([R1, R2, R3].join('\n'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    return screen.findByRole('region', { name: 'Review' });
  }

  it('the review shows the chain, every recipient, the total, the gas and what is left, and has sent nothing yet', async () => {
    const w = scriptedWallet({ balanceWei: 10n * 10n ** 18n });
    const review = await toReview(w);
    expect(within(review).getByText('Robinhood Chain Testnet')).toBeTruthy();
    for (const a of [R1, R2, R3]) expect(within(review).getByText(a)).toBeTruthy();
    expect(within(review).getByText('1.5 ETH')).toBeTruthy(); // total
    expect(await within(review).findByText('8.499937 ETH')).toBeTruthy(); // 10 - 1.5 - 3 x 21000 gas at 1 gwei
    expect(within(review).getByText(/exact: plain transfers cost 21,000 gas each/)).toBeTruthy();
    expect(w.sends()).toHaveLength(0);
  });

  it('Confirm and send is what asks the wallet to sign, once per recipient, and a full success charges the logo once', async () => {
    const w = scriptedWallet();
    const review = await toReview(w);
    await waitFor(() => expect((within(review).getByRole('button', { name: 'Confirm and send' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(review).getByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('Finished');
    expect(w.sends()).toHaveLength(3);
    const results = screen.getByRole('table', { name: 'Disperse results' });
    expect(within(results).getAllByText('confirmed')).toHaveLength(3);
    expect(within(results).getAllByRole('link')[0]!.getAttribute('href')).toMatch(/^https:\/\/explorer\.testnet\.chain\.robinhood\.com\/tx\/0x/);
    expect(chargeMock).toHaveBeenCalledTimes(1);
  });

  it('a rejection in the wallet stops the rest, marks them not sent, and does not charge the logo', async () => {
    const w = scriptedWallet({ rejectFrom: 1 });
    const review = await toReview(w);
    await waitFor(() => expect((within(review).getByRole('button', { name: 'Confirm and send' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(review).getByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('Finished');
    const results = screen.getByRole('table', { name: 'Disperse results' });
    expect(within(results).getAllByText('confirmed')).toHaveLength(1);
    expect(within(results).getAllByText('not sent')).toHaveLength(2);
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('a wallet that was moved to another network after review is refused, and nothing is signed', async () => {
    const w = scriptedWallet();
    const review = await toReview(w);
    await waitFor(() => expect((within(review).getByRole('button', { name: 'Confirm and send' }) as HTMLButtonElement).disabled).toBe(false));
    // the user switches network in their wallet behind our back
    await w.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
    fireEvent.click(within(review).getByRole('button', { name: 'Confirm and send' }));
    expect((await screen.findAllByText(/no longer on Robinhood Chain Testnet/)).length).toBeGreaterThan(0);
    expect(w.sends()).toHaveLength(0);
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('an amount that the balance cannot cover blocks the confirm', async () => {
    const w = scriptedWallet({ balanceWei: 10n ** 18n }); // 1 ETH, but 1.5 is being sent
    const review = await toReview(w);
    expect(await within(review).findByText(/Not enough balance/)).toBeTruthy();
    expect((within(review).getByRole('button', { name: 'Confirm and send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Back returns to the form with the recipients intact', async () => {
    const w = scriptedWallet();
    const review = await toReview(w);
    fireEvent.click(within(review).getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('table', { name: 'Recipients' })).toBeTruthy();
    expect(w.sends()).toHaveLength(0);
  });
});

describe('Disperse: from one of our wallets (operator only)', () => {
  it('sends through the server with per-recipient amounts, follows the receipts, and never lists the source as a recipient', async () => {
    disperseOutcome = () => ({
      ok: true,
      results: [
        { address: R1, amount: '0.25', status: 'sent', hash: '0x' + '1'.repeat(64) },
        { address: OUR[1]!.address, amount: '0.5', status: 'sent', hash: '0x' + '2'.repeat(64) },
      ],
    });
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Stryx wallet' }));
    fireEvent.click(screen.getByRole('radio', { name: /Robinhood Chain Testnet/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Select a wallet/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Alpha/ }));

    expect(screen.getByRole('radio', { name: 'Flat' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Variable' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Bravo/ }));
    pasteAddresses(R1);
    fireEvent.change(screen.getByLabelText('Amount for recipient 1'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Amount for recipient 2'), { target: { value: '0.25' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(false));
    // our own wallets are signed by the server: no "you will sign" warning
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const review = await screen.findByRole('region', { name: 'Review' });
    await waitFor(() => expect((within(review).getByRole('button', { name: 'Confirm and send' }) as HTMLButtonElement).disabled).toBe(false));
    expect(calls.some((c) => c.path === '/wallets/disperse')).toBe(false);
    fireEvent.click(within(review).getByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('Finished');
    const post = calls.find((c) => c.path === '/wallets/disperse');
    expect(post?.body).toEqual({
      sourceWalletId: 'w1',
      chainId: 46630,
      recipients: [
        { address: toChecksumAddress(OUR[1]!.address), amount: '0.5' },
        { address: R1, amount: '0.25' },
      ],
    });
    expect(within(screen.getByRole('table', { name: 'Disperse results' })).getAllByText('confirmed')).toHaveLength(2);
    expect(chargeMock).toHaveBeenCalledTimes(1);
  });

  it('a transfer the server could not send is shown failed, with a short message, and the logo does not charge', async () => {
    disperseOutcome = () => ({
      ok: false,
      results: [
        { address: R1, amount: '0.1', status: 'sent', hash: '0x' + '1'.repeat(64) },
        { address: R2, amount: '0.1', status: 'failed', error: 'insufficient funds for gas at https://rpc.example.com/v1/SECRETKEY' },
      ],
    });
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Stryx wallet' }));
    fireEvent.click(screen.getByRole('radio', { name: /Robinhood Chain Testnet/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Select a wallet/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Alpha/ }));
    fireEvent.change(screen.getByLabelText('Amount each'), { target: { value: '0.1' } });
    pasteAddresses([R1, R2].join('\n'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const review = await screen.findByRole('region', { name: 'Review' });
    await waitFor(() => expect((within(review).getByRole('button', { name: 'Confirm and send' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(review).getByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('Finished');
    const results = screen.getByRole('table', { name: 'Disperse results' });
    expect(within(results).getAllByText('failed')).toHaveLength(1);
    expect(results.textContent).not.toContain('SECRETKEY');
    expect(results.textContent).not.toContain('rpc.example.com');
    expect(chargeMock).not.toHaveBeenCalled();
  });
});

// keep `act` referenced for state flushes some environments need
void act;
