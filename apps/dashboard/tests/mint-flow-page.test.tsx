// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const calls: { path: string; method: string; body?: unknown }[] = [];
let responder: (path: string, method: string, body: unknown) => unknown = () => {
  throw new Error('unexpected call');
};

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    getToken: () => 'test-token',
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ path, method, body: options.body });
      return responder(path, method, options.body);
    }),
  };
});

import { MintFlowPage } from '../src/pages/MintFlowPage';
import { setRecentCollectionsAccount } from '../src/lib/recent-collections-store';

function mount(initialEntry = '/mint') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <MintFlowPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const RESOLVED = {
  contract: '0xAbC0000000000000000000000000000000000A',
  chainId: 46630,
  chainName: 'Robinhood Chain Testnet',
  openSeaUrl: 'https://opensea.io/assets/robinhood_testnet/0xAbC0000000000000000000000000000000000A',
  name: 'Cool Drop',
  image: { kind: 'external' as const, url: 'https://i.seadn.io/cool-drop.png' },
  mintedCount: 40,
  maxSupply: 100,
  mintableHere: true,
};

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  setRecentCollectionsAccount({ id: 'test-account' });
  responder = () => {
    throw new Error('unexpected call');
  };
});
afterEach(cleanup);

const lookUp = async (input: string) => {
  fireEvent.change(screen.getByLabelText(/OpenSea link, collection slug, or contract address/), { target: { value: input } });
  fireEvent.click(screen.getByRole('button', { name: /Look up/ }));
};

describe('MintFlowPage: resolving a collection', () => {
  it('resolves a pasted address and shows the header: name (linked), chain, contract, progress', async () => {
    responder = (path) => {
      if (path === '/resolve/collection') return RESOLVED;
      if (path.endsWith('/supply')) return { chainId: 46630, contract: RESOLVED.contract, mintedCount: 40, maxSupply: 100, fetchedAt: Date.now(), cached: false };
      throw new Error(`unexpected ${path}`);
    };
    mount();
    await lookUp(RESOLVED.contract);

    const header = await screen.findByRole('region', { name: 'Collection' });
    const link = within(header).getByRole('link', { name: /Cool Drop/ });
    expect(link.getAttribute('href')).toBe(RESOLVED.openSeaUrl);
    expect(within(header).getByText('Robinhood Chain Testnet')).toBeTruthy();
    expect(within(header).getByText(/40.*100 minted \(40%\)/)).toBeTruthy();
    const bar = within(header).getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
  });

  it('looks up a collection handed over in the URL (the Home page link), once', async () => {
    responder = (path) => {
      if (path === '/resolve/collection') return RESOLVED;
      if (path.endsWith('/supply')) return { chainId: 46630, contract: RESOLVED.contract, mintedCount: 40, maxSupply: 100, fetchedAt: Date.now(), cached: false };
      if (path.includes('/phases')) return { phases: [] };
      return null;
    };
    mount(`/mint?collection=${encodeURIComponent('https://opensea.io/collection/cool-drop')}`);
    await screen.findByRole('region', { name: 'Collection' });
    const input = screen.getByLabelText(/OpenSea link, collection slug, or contract address/) as HTMLInputElement;
    expect(input.value).toBe('https://opensea.io/collection/cool-drop');
    const resolves = calls.filter((c) => c.path === '/resolve/collection');
    expect(resolves).toHaveLength(1);
    expect(JSON.stringify(resolves[0]!.body)).toContain('cool-drop');
  });

  it('shows the chain picker when the address is ambiguous, and resolves once a chain is chosen', async () => {
    responder = (path, _method, body) => {
      if (path === '/resolve/collection') {
        const input = (body as { input: string; chainId?: number }).chainId;
        if (input === undefined) return { needsChainChoice: true, contract: RESOLVED.contract, chains: [{ chainId: 46630, name: 'Robinhood Chain Testnet' }, { chainId: 4663, name: 'Robinhood Chain' }] };
        return { ...RESOLVED, chainId: input, chainName: input === 4663 ? 'Robinhood Chain' : 'Robinhood Chain Testnet' };
      }
      if (path.endsWith('/supply')) return { chainId: 4663, contract: RESOLVED.contract, mintedCount: 1, maxSupply: 2, fetchedAt: Date.now(), cached: false };
      throw new Error(`unexpected ${path}`);
    };
    mount();
    await lookUp(RESOLVED.contract);

    expect(await screen.findByText(/has contract code on more than one chain/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Robinhood Chain$/ }));

    const header = await screen.findByRole('region', { name: 'Collection' });
    expect(within(header).getByText('Robinhood Chain')).toBeTruthy();
    expect(calls.filter((c) => c.path === '/resolve/collection')).toHaveLength(2);
  });

  it('a slow earlier lookup never replaces a newer one: the page shows what was asked for last', async () => {
    const OTHER = { ...RESOLVED, contract: '0xDeF0000000000000000000000000000000000B', name: 'Other Drop' };
    let releaseSlow: (value: unknown) => void = () => {};
    responder = (path, _method, body) => {
      if (path === '/resolve/collection') {
        return (body as { input: string }).input === 'slow-one' ? new Promise((resolve) => (releaseSlow = resolve)) : OTHER;
      }
      if (path.endsWith('/supply')) return { chainId: 46630, contract: OTHER.contract, mintedCount: 1, maxSupply: 2, fetchedAt: Date.now(), cached: false };
      if (path.includes('/phases')) return { phases: [] };
      return null;
    };
    mount();
    await lookUp('slow-one');
    const input = screen.getByLabelText(/OpenSea link, collection slug, or contract address/);
    fireEvent.change(input, { target: { value: 'fast-one' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await within(await screen.findByRole('region', { name: 'Collection' })).findByRole('link', { name: /Other Drop/ });

    releaseSlow(RESOLVED);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(within(screen.getByRole('region', { name: 'Collection' })).getByRole('link', { name: /Other Drop/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Cool Drop/ })).toBeNull();
  });

  it('a pasted proof does not follow you to the next collection', async () => {
    const OTHER = { ...RESOLVED, contract: '0xDeF0000000000000000000000000000000000B', name: 'Other Drop' };
    responder = (path, _method, body) => {
      if (path === '/resolve/collection') return (body as { input: string }).input === 'second' ? OTHER : RESOLVED;
      if (path.endsWith('/supply')) return { chainId: 46630, contract: RESOLVED.contract, mintedCount: 1, maxSupply: 2, fetchedAt: Date.now(), cached: false };
      if (path.includes('/phases')) return { phases: [] };
      if (path === '/wallets') return [];
      return null;
    };
    mount();
    await lookUp('first');
    fireEvent.click(await screen.findByRole('button', { name: /Manual allow-list mint/ }));
    const proof = () => screen.queryByPlaceholderText(/^\["0x1111/) as HTMLTextAreaElement | null;
    fireEvent.change(proof()!, { target: { value: '["0xproof-for-the-first-drop"]' } });

    await lookUp('second');
    await screen.findByRole('link', { name: /Other Drop/ });

    // The form is back to how a fresh collection starts: closed, with nothing typed in it.
    expect(proof()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Manual allow-list mint/ }));
    expect(proof()!.value).toBe('');
  });

  it('shows a short error message on a resolve failure, and no header', async () => {
    responder = () => {
      const err = new Error('boom') as Error & { status?: number; body?: unknown };
      throw err;
    };
    const { apiRequest } = await import('../src/lib/api');
    const { ApiError } = await import('../src/lib/api');
    vi.mocked(apiRequest).mockRejectedValueOnce(new ApiError(422, { error: 'resolve_failed', message: 'Could not parse an OpenSea collection or asset URL from that input.' }));

    mount();
    await lookUp('not a real url or address');

    expect(await screen.findByText(/Could not parse an OpenSea/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Collection' })).toBeNull();
  });

  it('shows "Supply unavailable" rather than a bar when supply numbers are null', async () => {
    responder = (path) => {
      if (path === '/resolve/collection') return { ...RESOLVED, mintedCount: null, maxSupply: null };
      if (path.endsWith('/supply')) return { chainId: 46630, contract: RESOLVED.contract, mintedCount: null, maxSupply: null, fetchedAt: Date.now(), cached: false };
      throw new Error(`unexpected ${path}`);
    };
    mount();
    await lookUp(RESOLVED.contract);

    const header = await screen.findByRole('region', { name: 'Collection' });
    expect(within(header).getByText('Supply unavailable')).toBeTruthy();
    expect(within(header).queryByRole('progressbar')).toBeNull();
  });

  it('shows the chain-not-configured note and no progress bar when mintableHere is false', async () => {
    responder = (path) => {
      if (path === '/resolve/collection') return { ...RESOLVED, mintableHere: false, mintedCount: null, maxSupply: null, note: 'Chain Ethereum has no RPC configured on this instance, so live supply cannot be read.' };
      throw new Error(`unexpected ${path}`);
    };
    mount();
    await lookUp(RESOLVED.contract);

    const header = await screen.findByRole('region', { name: 'Collection' });
    expect(within(header).getByText(/no RPC configured/)).toBeTruthy();
    expect(within(header).queryByRole('progressbar')).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/supply'))).toBe(false); // never polls a chain we have no RPC for
  });
});

describe('MintFlowPage: recent collections', () => {
  it('a resolved collection is added to Recent, and clicking it re-resolves the same input', async () => {
    responder = (path) => {
      if (path === '/resolve/collection') return RESOLVED;
      if (path.endsWith('/supply')) return { chainId: 46630, contract: RESOLVED.contract, mintedCount: 40, maxSupply: 100, fetchedAt: Date.now(), cached: false };
      throw new Error(`unexpected ${path}`);
    };
    mount();
    await lookUp(RESOLVED.contract);
    await screen.findByRole('region', { name: 'Collection' });

    fireEvent.change(screen.getByLabelText(/OpenSea link, collection slug, or contract address/), { target: { value: '' } });
    fireEvent.focus(screen.getByLabelText(/OpenSea link, collection slug, or contract address/));

    const list = await screen.findByRole('listbox', { name: 'Recent collections' });
    const option = within(list).getByRole('option', { name: new RegExp(RESOLVED.name) });
    fireEvent.click(option);

    await waitFor(() => expect(calls.filter((c) => c.path === '/resolve/collection')).toHaveLength(2));
    expect(calls[calls.length - 1]!.body).toMatchObject({ input: RESOLVED.contract });
  });

  it('shows nothing in the dropdown when there is no history yet', async () => {
    mount();
    fireEvent.focus(screen.getByLabelText(/OpenSea link, collection slug, or contract address/));
    expect(screen.queryByRole('listbox', { name: 'Recent collections' })).toBeNull();
  });
});
