// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../src/lib/api';

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
      if (path.startsWith('/wallets/balances')) return { balances: [] };
      return responder(path, options.method, options.body);
    }),
  };
});

import { DirectProofMint } from '../src/components/mint/DirectProofMint';
import { chooseQuick } from './helpers/date-time-picker';

const CHAIN_ID = 46630;
const CONTRACT = '0x1414429572eB0A138E0a8f9E8E94ff2c2DfCa5A9';
const PROOF = JSON.stringify([`0x${'1'.repeat(64)}`]);
const PARAMS = JSON.stringify({
  mintPrice: '10000000000000000',
  maxTotalMintableByWallet: 3,
  startTime: 1_700_000_000,
  endTime: 1_700_003_600,
  dropStageIndex: 1,
  maxTokenSupplyForStage: '500',
  feeBps: 250,
  restrictFeeRecipients: true,
});

function renderComponent() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DirectProofMint chainId={CHAIN_ID} nftContract={CONTRACT} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  responder = (path, method) => {
    throw new Error(`unexpected request in test: ${method ?? 'GET'} ${path}`);
  };
});
afterEach(cleanup);

describe('DirectProofMint', () => {
  it('stays collapsed until clicked, and does not fetch wallets before then', async () => {
    responder = (path) => {
      throw new Error(`unexpected request in test: GET ${path}`);
    };
    renderComponent();
    expect(screen.queryByText('Wallet')).toBeNull();
    expect(calls.find((c) => c.path === '/wallets')).toBeUndefined();
  });

  it('disables submit until wallet, quantity, proof and mint params are all valid', async () => {
    responder = (path) => {
      if (path === '/wallets') return [{ id: 'w1', address: '0x1111111111111111111111111111111111111a', label: 'Alpha', tier: 'HOT', status: 'ACTIVE' }];
      throw new Error(`unexpected request in test: GET ${path}`);
    };
    renderComponent();
    fireEvent.click(screen.getByRole('button', { name: /Manual allow-list mint/ }));

    expect((screen.getByRole('button', { name: 'Mint now' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: /Select a wallet/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Alpha/ }));
    expect((screen.getByRole('button', { name: 'Mint now' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/0x1111111111111111111111111111111111111111111111111111111111111111/), { target: { value: PROOF } });
    expect((screen.getByRole('button', { name: 'Mint now' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/mintPrice/), { target: { value: PARAMS } });
    expect((screen.getByRole('button', { name: 'Mint now' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows an inline error for malformed proof JSON without throwing', async () => {
    responder = (path) => {
      if (path === '/wallets') return [];
      throw new Error(`unexpected request in test: GET ${path}`);
    };
    renderComponent();
    fireEvent.click(screen.getByRole('button', { name: /Manual allow-list mint/ }));
    fireEvent.change(await screen.findByPlaceholderText(/0x1111111111111111111111111111111111111111111111111111111111111111/), { target: { value: 'not json' } });
    expect(await screen.findByText('Proof is not valid JSON.')).toBeTruthy();
  });

  it('mints now via /mints/seadrop/allowlist with proofSource direct, and shows the hash', async () => {
    responder = (path, method) => {
      if (path === '/wallets') return [{ id: 'w1', address: '0x1111111111111111111111111111111111111a', label: 'Alpha', tier: 'HOT', status: 'ACTIVE' }];
      if (path === '/mints/seadrop/allowlist' && method === 'POST') return { hash: `0x${'a'.repeat(64)}` };
      throw new Error(`unexpected request in test: ${method} ${path}`);
    };
    renderComponent();
    fireEvent.click(screen.getByRole('button', { name: /Manual allow-list mint/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Select a wallet/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Alpha/ }));
    fireEvent.change(screen.getByPlaceholderText(/0x1111111111111111111111111111111111111111111111111111111111111111/), { target: { value: PROOF } });
    fireEvent.change(screen.getByPlaceholderText(/mintPrice/), { target: { value: PARAMS } });

    fireEvent.click(screen.getByRole('button', { name: 'Mint now' }));

    await screen.findByText('Sent.');
    const call = calls.find((c) => c.path === '/mints/seadrop/allowlist');
    expect(call).toBeTruthy();
    expect(call!.body).toMatchObject({ walletId: 'w1', nftContract: CONTRACT, chainId: CHAIN_ID, quantity: 1, proofSource: 'direct' });
  });

  it('schedules via /schedules/mints with kind allowlist-direct when an explicit time is set', async () => {
    responder = (path, method) => {
      if (path === '/wallets') return [{ id: 'w1', address: '0x1111111111111111111111111111111111111a', label: 'Alpha', tier: 'HOT', status: 'ACTIVE' }];
      if (path === '/schedules/mints' && method === 'POST') return { jobId: 'job-9' };
      throw new Error(`unexpected request in test: ${method} ${path}`);
    };
    renderComponent();
    fireEvent.click(screen.getByRole('button', { name: /Manual allow-list mint/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Select a wallet/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Alpha/ }));
    fireEvent.change(screen.getByPlaceholderText(/0x1111111111111111111111111111111111111111111111111111111111111111/), { target: { value: PROOF } });
    fireEvent.change(screen.getByPlaceholderText(/mintPrice/), { target: { value: PARAMS } });

    fireEvent.click(screen.getByRole('button', { name: 'Schedule for later' }));
    expect((screen.getByRole('button', { name: 'Schedule mint' }) as HTMLButtonElement).disabled).toBe(true);
    chooseQuick(/Runs at/, 'In 1 hour');

    fireEvent.click(screen.getByRole('button', { name: 'Schedule mint' }));

    await screen.findByText('Scheduled (job job-9).');
    const call = calls.find((c) => c.path === '/schedules/mints');
    expect(call).toBeTruthy();
    expect(call!.body).toMatchObject({ kind: 'allowlist-direct', walletId: 'w1' });
  });

  it('shows the backend error message on failure', async () => {
    responder = (path, method) => {
      if (path === '/wallets') return [{ id: 'w1', address: '0x1111111111111111111111111111111111111a', label: 'Alpha', tier: 'HOT', status: 'ACTIVE' }];
      if (path === '/mints/seadrop/allowlist' && method === 'POST') throw new ApiError(403, { error: 'not_eligible', reason: 'not_on_allowlist' });
      throw new Error(`unexpected request in test: ${method} ${path}`);
    };
    renderComponent();
    fireEvent.click(screen.getByRole('button', { name: /Manual allow-list mint/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Select a wallet/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Alpha/ }));
    fireEvent.change(screen.getByPlaceholderText(/0x1111111111111111111111111111111111111111111111111111111111111111/), { target: { value: PROOF } });
    fireEvent.change(screen.getByPlaceholderText(/mintPrice/), { target: { value: PARAMS } });

    fireEvent.click(screen.getByRole('button', { name: 'Mint now' }));

    await screen.findByText('Not eligible (not_on_allowlist).');
  });
});
