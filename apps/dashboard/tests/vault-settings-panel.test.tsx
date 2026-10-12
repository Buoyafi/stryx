// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../src/lib/api';

const CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890';
const VAULT = '0x9999999999999999999999999999999999999999';

const calls: { path: string; method?: string; body?: unknown }[] = [];
let responder: (path: string, method: string | undefined, body: unknown) => unknown = () => {
  throw new Error('unexpected request in test');
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

import { VaultSettingsPanel } from '../src/components/mint/VaultSettingsPanel';

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VaultSettingsPanel chainId={CHAIN_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  responder = (path) => {
    if (path.startsWith('/vault-settings?')) return { enabled: false, vaultAddress: null, lastDrainFailure: null };
    throw new Error(`unexpected request in test: ${path}`);
  };
});
afterEach(cleanup);

describe('VaultSettingsPanel', () => {
  it('loads disabled with no address field shown by default', async () => {
    renderPanel();
    await screen.findByRole('switch', { name: 'Send minted NFTs to a vault address' });
    expect(screen.getByRole('switch', { name: 'Send minted NFTs to a vault address' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByPlaceholderText(/vault address/)).toBeNull();
  });

  it('only offers Save once something changed', async () => {
    renderPanel();
    await screen.findByRole('switch', { name: 'Send minted NFTs to a vault address' });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Send minted NFTs to a vault address' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('shows the address field once the switch is turned on', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('switch', { name: 'Send minted NFTs to a vault address' }));
    expect(screen.getByPlaceholderText(/vault address/)).toBeTruthy();
  });

  it('saves enabled + address for the chain', async () => {
    responder = (path, method, body) => {
      if (path.startsWith('/vault-settings?')) return { enabled: false, vaultAddress: null, lastDrainFailure: null };
      if (path === '/vault-settings' && method === 'PUT') {
        const input = body as { enabled: boolean; vaultAddress: string | null };
        return { enabled: input.enabled, vaultAddress: input.vaultAddress };
      }
      throw new Error(`unexpected request in test: ${method ?? 'GET'} ${path}`);
    };

    renderPanel();
    fireEvent.click(await screen.findByRole('switch', { name: 'Send minted NFTs to a vault address' }));
    fireEvent.change(screen.getByPlaceholderText(/vault address/), { target: { value: VAULT } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.path === '/vault-settings' && c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ chainId: CHAIN_ID, enabled: true, vaultAddress: VAULT });
  });

  it('shows a form error when the server rejects an empty vault address', async () => {
    responder = (path, method) => {
      if (path.startsWith('/vault-settings?')) return { enabled: false, vaultAddress: null, lastDrainFailure: null };
      if (path === '/vault-settings' && method === 'PUT') throw new ApiError(400, { error: 'vault_address_required' });
      throw new Error(`unexpected request in test: ${method ?? 'GET'} ${path}`);
    };

    renderPanel();
    fireEvent.click(await screen.findByRole('switch', { name: 'Send minted NFTs to a vault address' }));
    fireEvent.change(screen.getByPlaceholderText(/vault address/), { target: { value: VAULT } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Enter a valid vault address.');
  });

  it('prompts to re-confirm and retries the save once step-up succeeds', async () => {
    let putAttempts = 0;
    responder = (path, method) => {
      if (path.startsWith('/vault-settings?')) return { enabled: false, vaultAddress: null, lastDrainFailure: null };
      if (path === '/vault-settings' && method === 'PUT') {
        putAttempts += 1;
        if (putAttempts === 1) throw new ApiError(403, { error: 'step_up_required' });
        return { enabled: true, vaultAddress: VAULT };
      }
      if (path === '/auth/step-up' && method === 'POST') return { ok: true };
      throw new Error(`unexpected request in test: ${method ?? 'GET'} ${path}`);
    };

    renderPanel();
    fireEvent.click(await screen.findByRole('switch', { name: 'Send minted NFTs to a vault address' }));
    fireEvent.change(screen.getByPlaceholderText(/vault address/), { target: { value: VAULT } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText("Confirm it's you");
    fireEvent.change(screen.getByPlaceholderText('API token'), { target: { value: 'my-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(putAttempts).toBe(2));
    expect(screen.queryByText("Confirm it's you")).toBeNull();
  });

  it('shows a plain drain-failure notice when the server reports one', async () => {
    responder = (path) => {
      if (path.startsWith('/vault-settings?')) {
        return { enabled: true, vaultAddress: VAULT, lastDrainFailure: { contract: CONTRACT, tokenId: '7', error: 'Simulation reverted: boom', at: new Date().toISOString() } };
      }
      throw new Error(`unexpected request in test: ${path}`);
    };

    renderPanel();
    await screen.findByText(/Vault transfer failed for token #7/);
    expect(screen.getByText(/still in the minting wallet/)).toBeTruthy();
    expect(screen.queryByText(/Simulation reverted: boom/)).toBeNull(); // the cause is behind Details
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/Simulation reverted: boom/)).toBeTruthy();
  });
});
