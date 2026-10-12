// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  calls: [] as { path: string; method: string; body?: unknown }[],
  handlers: {} as Record<string, (body: unknown) => unknown>,
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      api.calls.push({ path, method: options.method ?? 'GET', body: options.body });
      const handler = api.handlers[path];
      if (!handler) throw new actual.ApiError(404, { error: 'not_found' });
      return handler(options.body);
    }),
  };
});

import { ApiError, TERMS_NEEDED_EVENT } from '../src/lib/api';
import { WelcomeCard } from '../src/components/WelcomeCard';
import { TermsGate } from '../src/components/TermsGate';
import { createWalletConnectStore } from '../src/lib/wallet-connect-store';

const V1 = { termsVersion: '1.0', privacyVersion: '1.0' };
const ADDRESS = '0x' + 'ab'.repeat(20);
const SIWE = 'localhost wants you to sign in with your Ethereum account:\n' + ADDRESS + '\n\nSign in to Stryx.';
const SIGNATURE = '0x' + '12'.repeat(65);

function installWallet() {
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [ADDRESS];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'personal_sign') return SIGNATURE;
      throw new Error(`unexpected ${method}`);
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  (window as unknown as { ethereum?: unknown }).ethereum = provider;
}

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);

async function pickWallet() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(await within(dialog).findByRole('button', { name: /Browser wallet/ }, { timeout: 2000 }));
}

/** Gets a held code ticket in place, so the card opens on the wallet step. */
function holdTicket() {
  sessionStorage.setItem('stryx.codeTicket', JSON.stringify({ ticket: 'ticket-abcdefghijklmnop', expiresAt: Date.now() + 600_000 }));
}

beforeEach(() => {
  sessionStorage.clear();
  api.calls = [];
  api.handlers = {
    '/auth/options': () => ({ walletSignIn: true, terms: V1 }),
    '/auth/siwe/challenge': () => ({ siweMessage: SIWE }),
    '/auth/siwe/verify': () => ({ created: true }),
  };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

describe('sign-up: the acceptance box', () => {
  it('a new account cannot connect until the box is ticked, and the ticked versions go with the sign-in', async () => {
    installWallet();
    holdTicket();
    const onSignedIn = vi.fn();
    render(wrap(<WelcomeCard onSignedIn={onSignedIn} store={createWalletConnectStore()} />));
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    expect(box.checked).toBe(false); // never pre-ticked
    expect(screen.getByText(/I confirm that I am 18 or older and agree to the Stryx/)).toBeTruthy();
    expect(screen.getByText(/blockchain transactions are generally irreversible/)).toBeTruthy();
    const connect = screen.getByRole('button', { name: 'Connect wallet' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.click(box);
    expect(connect.disabled).toBe(false);
    await pickWallet();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(api.calls.find((c) => c.path === '/auth/siwe/verify')!.body).toEqual({ message: SIWE, signature: SIGNATURE, ticket: 'ticket-abcdefghijklmnop', acceptedTerms: V1 });
  });

  it('a returning wallet is never asked, and sends no acceptance', async () => {
    installWallet();
    api.handlers['/auth/siwe/verify'] = () => ({ created: false });
    const onSignedIn = vi.fn();
    render(wrap(<WelcomeCard onSignedIn={onSignedIn} store={createWalletConnectStore()} />));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/auth/options')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your wallet' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'Connect wallet' }) as HTMLButtonElement).disabled).toBe(false);
    await pickWallet();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(api.calls.find((c) => c.path === '/auth/siwe/verify')!.body).not.toHaveProperty('acceptedTerms');
  });

  it('shows no box and blocks nothing when the server is not asking', async () => {
    installWallet();
    holdTicket();
    api.handlers['/auth/options'] = () => ({ walletSignIn: true, terms: null });
    render(wrap(<WelcomeCard onSignedIn={vi.fn()} store={createWalletConnectStore()} />));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/auth/options')).toBe(true));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'Connect wallet' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('if the server says the terms changed under the visitor, it says so and clears the tick', async () => {
    installWallet();
    holdTicket();
    api.handlers['/auth/siwe/verify'] = () => {
      throw new ApiError(400, { error: 'terms_required', message: 'Please accept the Terms of Use and Privacy Policy to create your account.' });
    };
    render(wrap(<WelcomeCard onSignedIn={vi.fn()} store={createWalletConnectStore()} />));
    fireEvent.click(await screen.findByRole('checkbox'));
    await pickWallet();
    expect((await screen.findByRole('alert')).textContent).toMatch(/terms were updated/i);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
});

describe('TermsGate', () => {
  const status = (over: Record<string, unknown> = {}) => ({ required: true, accepted: false, ...V1, acceptedAt: null, ...over });

  it('asks a member who has not accepted, with the box unticked and Accept disabled until it is ticked', async () => {
    api.handlers['/me/terms'] = () => status();
    render(wrap(<TermsGate />));
    const dialog = await screen.findByRole('dialog', { name: 'Please review our terms' });
    expect(within(dialog).getByText(/can still look around, cancel anything scheduled, export a key and move your assets/)).toBeTruthy();
    const accept = within(dialog).getByRole('button', { name: 'Accept and continue' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(accept.disabled).toBe(false);
  });

  it('accepting sends the versions in force, then closes', async () => {
    let current = status();
    api.handlers['/me/terms'] = () => current;
    api.handlers['/me/terms/accept'] = () => ((current = status({ accepted: true, acceptedAt: '2026-10-03T00:00:00Z' })), current);
    render(wrap(<TermsGate />));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept and continue' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find((c) => c.path === '/me/terms/accept')).toMatchObject({ method: 'POST', body: V1 });
  });

  it('says plainly when saving fails, and stays open', async () => {
    api.handlers['/me/terms'] = () => status();
    api.handlers['/me/terms/accept'] = () => {
      throw new ApiError(409, { error: 'terms_changed', message: 'The terms were updated. Please read the new version.' });
    };
    render(wrap(<TermsGate />));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept and continue' }));
    expect(await screen.findByText('The terms were updated. Please read the new version.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('stays out of the way when nothing is needed: accepted, or not required', async () => {
    api.handlers['/me/terms'] = () => status({ accepted: true });
    const first = render(wrap(<TermsGate />));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/me/terms')).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
    first.unmount();
    api.handlers['/me/terms'] = () => status({ required: false, accepted: true, termsVersion: null, privacyVersion: null });
    render(wrap(<TermsGate />));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/me/terms').length).toBeGreaterThan(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Not now" and Escape close it, and a refused write opens it again', async () => {
    api.handlers['/me/terms'] = () => status();
    render(wrap(<TermsGate />));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => void window.dispatchEvent(new Event(TERMS_NEEDED_EVENT)));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('apiRequest and a refused write', () => {
  it('tells the page when the API says the terms are not accepted, and only then', async () => {
    const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
    const seen = vi.fn();
    window.addEventListener(TERMS_NEEDED_EVENT, seen);
    const reply = (status: number, body: unknown) => vi.fn(async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }));
    vi.stubGlobal('fetch', reply(403, { error: 'terms_not_accepted', message: 'x' }));
    await expect(actual.apiRequest('/wallets', { method: 'POST', body: {} })).rejects.toBeInstanceOf(actual.ApiError);
    expect(seen).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', reply(403, { error: 'forbidden' }));
    await expect(actual.apiRequest('/admin/overview')).rejects.toBeInstanceOf(actual.ApiError);
    vi.stubGlobal('fetch', reply(500, { error: 'terms_not_accepted' }));
    await expect(actual.apiRequest('/wallets')).rejects.toBeInstanceOf(actual.ApiError);
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(TERMS_NEEDED_EVENT, seen);
    vi.unstubAllGlobals();
  });
});
