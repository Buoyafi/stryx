// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const calls: string[] = [];
const WALLETS = [
  { id: 'w1', address: '0x1111111111111111111111111111111111111a', label: 'one', tier: 'HOT', status: 'ACTIVE', origin: 'GENERATED', keyVersion: 1, createdAt: '2026-01-01' },
  { id: 'w2', address: '0x2222222222222222222222222222222222222b', label: 'two', tier: 'HOT', status: 'ACTIVE', origin: 'GENERATED', keyVersion: 1, createdAt: '2026-01-01' },
];

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string) => {
      calls.push(path);
      if (path === '/wallets') return WALLETS;
      if (path === '/chains') return { chains: [{ chainId: 1, name: 'Ethereum' }, { chainId: 137, name: 'Polygon' }] };
      if (path === '/wallets/balances?chainId=1') return { chainId: 1, balances: [{ walletId: 'w1', wei: '1500000000000000000' }, { walletId: 'w2', wei: '0', error: 'Ethereum RPC did not answer in time.' }] };
      if (path === '/wallets/balances?chainId=137') return { chainId: 137, balances: [{ walletId: 'w1', wei: '2000000000000000000' }, { walletId: 'w2', wei: '3000000000000000000' }] };
      throw new Error(`unexpected request in test: ${path}`);
    }),
  };
});

import { WalletsPage } from '../src/pages/WalletsPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <WalletsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  calls.length = 0;
  try {
    localStorage.clear();
  } catch {
    // jsdom always has it; guard anyway.
  }
});
afterEach(cleanup);

describe('Wallets page: balances per chain', () => {
  it("shows every wallet's balance on the first chain in its own symbol, with a total and unreadable count", async () => {
    renderPage();
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('1.5 ETH')).toBeTruthy();
    expect(within(table).getByText('unreadable').getAttribute('title')).toBe('Ethereum RPC did not answer in time.');
    expect(screen.getByLabelText('Balance total').textContent).toMatch(/Total 1\.5 ETH/);
    expect(screen.getByText("1 wallet couldn't be read on this chain, so the total may be low.")).toBeTruthy();
    expect(calls).toContain('/wallets/balances?chainId=1');
  });

  it('switching chain reads that chain only and shows its own token (POL, not ETH)', async () => {
    renderPage();
    const table = await screen.findByRole('table');
    await within(table).findByText('1.5 ETH');
    fireEvent.click(screen.getByRole('radio', { name: /Polygon/ }));
    await waitFor(() => expect(within(table).getByText('2 POL')).toBeTruthy());
    expect(within(table).getByText('3 POL')).toBeTruthy();
    expect(screen.getByLabelText('Balance total').textContent).toMatch(/Total 5 POL/);
  });
});

describe('Wallets page: no dropdown per wallet', () => {
  it('shows each wallet on one row with everything on it, and clicking a row opens nothing', async () => {
    renderPage();
    const table = await screen.findByRole('table');
    await within(table).findByText('1.5 ETH');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Label', 'Address', 'Balance', 'Tier', 'Status', 'Key version', 'Actions']);
    const rows = table.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.className).toContain('wl-row'); // not `wallet-row`, which is the Mint page's own layout
    const before = table.querySelectorAll('tbody tr').length;
    fireEvent.click(rows[0]!);
    expect(table.querySelectorAll('tbody tr').length).toBe(before);
    expect(screen.queryByText('Full address')).toBeNull();
    expect(screen.queryByText(/Reading balances/)).toBeNull();
  });
});
