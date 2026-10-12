// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// The whole app is drawn here, with pages loaded on demand: on a busy machine the first screen can
// take longer than the 1 second a lookup waits by default, and this file used to fail at random.
configure({ asyncUtilTimeout: 8_000 });
vi.setConfig({ testTimeout: 30_000 });

const api = vi.hoisted(() => ({
  options: 'on' as 'on' | 'off',
  me: null as null | Record<string, unknown>,
  /** What GET /wallets answers: fine, "that token is not valid", or "the API is down". */
  wallets: 'ok' as 'ok' | 'refused' | 'down',
  calls: [] as { path: string; method: string }[],
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string } = {}) => {
      api.calls.push({ path, method: options.method ?? 'GET' });
      if (path === '/auth/options') {
        if (api.options === 'off') throw new actual.ApiError(401, { error: 'unauthorized' });
        return { walletSignIn: true };
      }
      if (path === '/auth/me') {
        if (!api.me) throw new actual.ApiError(401, { error: 'unauthorized' });
        return api.me;
      }
      if (path === '/auth/logout') {
        api.me = null;
        return null;
      }
      if (path.startsWith('/home/drops')) return { window: '7d', fetchedAt: new Date().toISOString(), warning: null, upcoming: [], pastMints: [] };
      if (path === '/wallets') {
        if (api.wallets === 'refused') throw new actual.ApiError(401, { error: 'unauthorized', message: 'Invalid API token.' });
        if (api.wallets === 'down') throw new actual.ApiError(503, null);
        return [];
      }
      return {};
    }),
  };
});

import { App } from '../src/App';
import { mintFeedStore, storageKeyFor, LEGACY_STORAGE_KEY } from '../src/lib/mint-feed-store';
import { SESSION_ENDED_EVENT } from '../src/lib/api';

function setLayout(kind: 'rail' | 'touch') {
  window.matchMedia = ((q: string) => ({ matches: kind === 'touch', media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
}

function renderApp(path = '/home') {
  // StrictMode as in main.tsx: it runs state initializers twice, which once hid "You are in".
  return render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mintFeedStore.setAccount(null);
  api.options = 'on';
  api.me = null;
  api.wallets = 'ok';
  api.calls = [];
  setLayout('rail');
});
afterEach(cleanup);

describe('who is looking', () => {
  it('with wallet sign-in off, the operator token login is the only door (as before)', async () => {
    api.options = 'off';
    renderApp();
    expect(await screen.findByPlaceholderText('API token')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Got a code?' })).toBeNull();
  });

  it('a visitor sees Home with "Got a code?", every other section locked, and no sign-out', async () => {
    renderApp('/wallets');
    expect(await screen.findByRole('heading', { name: 'Got a code?' })).toBeTruthy(); // /wallets sent back to Home
    const locked = screen.getByRole('link', { name: 'Wallets, needs an invite code' });
    expect(locked.getAttribute('href')).toBe('/home');
    expect(screen.getByRole('link', { name: 'Mint, needs an invite code' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy(); // Home itself opens
    expect(screen.queryByTitle('Sign out')).toBeNull();
    expect(api.calls.some((c) => c.path === '/wallets')).toBe(false); // nothing private was asked for
  });

  it('the operator can still reach the token login from the visitor view', async () => {
    renderApp('/login/token');
    expect(await screen.findByPlaceholderText('API token')).toBeTruthy();
  });

  it('a wallet session opens everything, and signing out asks the API to end it', async () => {
    api.me = { id: 'u1', email: null, role: 'USER', status: 'ACTIVE', discordHandle: null, xHandle: null, createdAt: '2026-09-30T00:00:00Z', signedInWith: 'wallet', signInAddresses: ['0x' + 'ab'.repeat(20)] };
    renderApp();
    const wallets = await screen.findByRole('link', { name: 'Wallets' });
    expect(wallets.getAttribute('href')).toBe('/wallets');
    expect(screen.queryByRole('heading', { name: 'Got a code?' })).toBeNull();
    fireEvent.click(screen.getByTitle('Sign out'));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/auth/logout' && c.method === 'POST')).toBe(true));
    expect(await screen.findByRole('heading', { name: 'Got a code?' })).toBeTruthy();
  });

  it('a brand-new account sees "You are in" once on Home', async () => {
    sessionStorage.setItem('stryx.justJoined', '1');
    api.me = { id: 'u1', email: null, role: 'USER', status: 'ACTIVE', discordHandle: null, xHandle: null, createdAt: '2026-09-30T00:00:00Z', signedInWith: 'wallet' };
    renderApp();
    expect(await screen.findByRole('heading', { name: 'You are in.' })).toBeTruthy();
    expect(screen.getByLabelText('Your name')).toBeTruthy(); // asked what to call them
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.getByRole('link', { name: 'Create your first wallet' }).getAttribute('href')).toBe('/wallets');
    expect(sessionStorage.getItem('stryx.justJoined')).toBeNull();
  });

  it('a stored operator token still signs straight in', async () => {
    sessionStorage.setItem('stryx.token', 'op');
    renderApp();
    expect(await screen.findByRole('link', { name: 'Wallets' })).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/auth/options')).toBe(false);
  });

  it("on a shared browser, the next account never sees the last one's mints, and signing out deletes them", async () => {
    const who = (id: string) => ({ id, email: null, role: 'USER', status: 'ACTIVE', discordHandle: null, xHandle: null, createdAt: '2026-09-30T00:00:00Z', signedInWith: 'wallet' });
    const aMint = { id: 'tx:a', at: Date.now(), chainId: 46630, nftContract: '0xc', walletId: 'wa', address: '0xa', quantity: 1, hash: `0x${'a'.repeat(64)}` };

    api.me = who('alice');
    const first = renderApp();
    await screen.findByRole('link', { name: 'Wallets' });
    await waitFor(() => expect(localStorage.getItem(storageKeyFor('alice'))).not.toBeNull());
    mintFeedStore.recordMints([aMint]);
    expect(mintFeedStore.getSnapshot().device).toHaveLength(1);
    fireEvent.click(screen.getByTitle('Sign out'));
    await screen.findByRole('heading', { name: 'Got a code?' });
    expect(localStorage.getItem(storageKeyFor('alice'))).toBeNull();
    expect(mintFeedStore.getSnapshot().device).toEqual([]);
    first.unmount();

    api.me = who('bob');
    renderApp();
    await screen.findByRole('link', { name: 'Wallets' });
    await waitFor(() => expect(localStorage.getItem(storageKeyFor('bob'))).not.toBeNull());
    expect(mintFeedStore.getSnapshot().device).toEqual([]);
  });

  it('a member never inherits the record from before accounts; the operator does', async () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ device: [{ id: 'old', at: 1000, chainId: 46630, nftContract: '0xc', walletId: 'w', address: '0xa', quantity: 1, error: 'x' }], receipts: {}, charged: {} }));
    api.me = { id: 'member-1', email: null, role: 'USER', status: 'ACTIVE', discordHandle: null, xHandle: null, createdAt: '2026-09-30T00:00:00Z', signedInWith: 'wallet' };
    const member = renderApp();
    await screen.findByRole('link', { name: 'Wallets' });
    await waitFor(() => expect(localStorage.getItem(storageKeyFor('member-1'))).not.toBeNull());
    expect(mintFeedStore.getSnapshot().device).toEqual([]);
    member.unmount();

    sessionStorage.setItem('stryx.token', 'op');
    api.me = { id: 'operator', email: null, role: 'ADMIN', status: 'ACTIVE', discordHandle: null, xHandle: null, createdAt: '2026-09-30T00:00:00Z', signedInWith: 'token' };
    renderApp();
    await waitFor(() => expect(mintFeedStore.getSnapshot().device.map((m) => m.id)).toEqual(['old']));
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });
});

describe('when the sign-in stops being good', () => {
  const member = { id: 'u1', email: null, role: 'USER', status: 'ACTIVE', discordHandle: null, xHandle: null, createdAt: '2026-09-30T00:00:00Z', signedInWith: 'wallet' };

  it('a session that ends in the middle of a visit goes back to signing in, and says why', async () => {
    api.me = member;
    renderApp();
    await screen.findByRole('link', { name: 'Wallets' });

    // The API refuses the next request: expired, ended from another device, or suspended.
    api.me = null;
    window.dispatchEvent(new Event(SESSION_ENDED_EVENT));

    expect(await screen.findByRole('heading', { name: 'Got a code?' })).toBeTruthy();
    expect(await screen.findByText('You were signed out')).toBeTruthy();
    expect(screen.queryByTitle('Sign out')).toBeNull();
  });

  it('a refusal while nobody is signed in is not "a session ending"', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Got a code?' });
    window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    expect(screen.queryByText('You were signed out')).toBeNull();
  });

  it('the API being down does not throw the operator token away', async () => {
    sessionStorage.setItem('stryx.token', 'op');
    api.wallets = 'down';
    renderApp();
    expect(await screen.findByText(/Stryx is not reachable right now/)).toBeTruthy();
    expect(sessionStorage.getItem('stryx.token')).toBe('op');

    api.wallets = 'ok';
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Wallets' })).toBeTruthy();
    expect(sessionStorage.getItem('stryx.token')).toBe('op');
  });

  it('a token the API refuses is thrown away', async () => {
    sessionStorage.setItem('stryx.token', 'stale');
    api.wallets = 'refused';
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Got a code?' })).toBeTruthy();
    expect(sessionStorage.getItem('stryx.token')).toBeNull();
  });

  it('signing out ends both the token and a wallet session held at the same time', async () => {
    sessionStorage.setItem('stryx.token', 'op');
    api.me = member; // a wallet session cookie is in this browser too
    renderApp();
    await screen.findByRole('link', { name: 'Wallets' });
    fireEvent.click(screen.getByTitle('Sign out'));
    expect(await screen.findByRole('heading', { name: 'Got a code?' })).toBeTruthy();
    expect(sessionStorage.getItem('stryx.token')).toBeNull();
    expect(api.calls.some((c) => c.path === '/auth/logout' && c.method === 'POST')).toBe(true);
  });
});
