// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  calls: [] as { path: string; method: string; body?: unknown }[],
  /** path -> handler; a thrown ApiError is the server refusing. */
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

import { ApiError } from '../src/lib/api';
import { WelcomeCard, codeFromLink, showOperatorLogin, splitCode } from '../src/components/WelcomeCard';
import { createWalletConnectStore } from '../src/lib/wallet-connect-store';

const ADDRESS = '0x' + 'ab'.repeat(20);
const SIWE = 'localhost wants you to sign in with your Ethereum account:\n' + ADDRESS + '\n\nSign in to Stryx.';
const SIGNATURE = '0x' + '12'.repeat(65);

/** A wallet the page finds as window.ethereum. Records what it was asked to sign. */
function installWallet(opts: { reject?: boolean } = {}) {
  const signed: unknown[] = [];
  const provider = {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_requestAccounts') return [ADDRESS];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'personal_sign') {
        if (opts.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        signed.push(params);
        return SIGNATURE;
      }
      throw new Error(`unexpected ${method}`);
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  (window as unknown as { ethereum?: unknown }).ethereum = provider;
  return { provider, signed };
}

function renderCard(onSignedIn = vi.fn()) {
  const store = createWalletConnectStore();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <WelcomeCard onSignedIn={onSignedIn} store={store} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onSignedIn, store };
}

/** One "Connect wallet" button, then the wallet picked in the chooser. */
async function pickWallet() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(await within(dialog).findByRole('button', { name: /Browser wallet/ }, { timeout: 2000 }));
}

beforeEach(() => {
  sessionStorage.clear();
  api.calls = [];
  api.handlers = {
    '/auth/code/check': (body) => {
      if ((body as { code: string }).code !== 'STRYX-7K2P-QX9M') throw new ApiError(400, { error: 'code_invalid', message: 'That code is not valid or was already used.' });
      return { ticket: 'ticket-abcdefghijklmnop', expiresInSeconds: 900 };
    },
    '/auth/siwe/challenge': () => ({ siweMessage: SIWE }),
    '/auth/siwe/verify': (body) => ((body as { ticket?: string }).ticket ? { created: true } : { created: false }),
  };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

const decode = (hex: string) => new TextDecoder().decode(Uint8Array.from(hex.slice(2).match(/.{2}/g)!.map((b) => parseInt(b, 16))));

describe('splitCode', () => {
  it('reads a pasted code in any shape', () => {
    expect(splitCode('STRYX-7K2P-QX9M')).toEqual(['7K2P', 'QX9M']);
    expect(splitCode(' stryx 7k2p qx9m ')).toEqual(['7K2P', 'QX9M']);
    expect(splitCode('7k2p')).toEqual(['7K2P', '']);
  });
});

describe('the link in an invite email', () => {
  it('reads only a whole code from ?code=', () => {
    expect(codeFromLink('?code=STRYX-7K2P-QX9M')).toEqual(['7K2P', 'QX9M']);
    expect(codeFromLink('?x=1&code=stryx-7k2p-qx9m')).toEqual(['7K2P', 'QX9M']);
    expect(codeFromLink('?code=STRYX-7K2P')).toBeNull();
    expect(codeFromLink('')).toBeNull();
  });

  it('opens on the code step with the code filled in, and clears it from the address bar', async () => {
    window.history.replaceState(null, '', '/home?code=STRYX-7K2P-QX9M');
    installWallet();
    renderCard();
    expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeTruthy();
    expect((screen.getByLabelText('Invite code, first four characters') as HTMLInputElement).value).toBe('7K2P');
    expect((screen.getByLabelText('Invite code, last four characters') as HTMLInputElement).value).toBe('QX9M');
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/home');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Code accepted. Now your wallet.' })).toBeTruthy();
    window.history.replaceState(null, '', '/');
  });
});

describe('Got a code?', () => {
  it('code, then wallet: the wallet signs the server message and the held ticket goes with it', async () => {
    const { signed } = installWallet();
    const { onSignedIn } = renderCard();
    expect(screen.getByRole('heading', { name: 'Got a code?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I have one' }));

    // Pasting the whole code into the first box fills both.
    fireEvent.change(screen.getByLabelText('Invite code, first four characters'), { target: { value: 'stryx-7k2p-qx9m' } });
    expect((screen.getByLabelText('Invite code, last four characters') as HTMLInputElement).value).toBe('QX9M');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Code accepted. Now your wallet.' })).toBeTruthy();
    await pickWallet();

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(signed).toHaveLength(1);
    const [hex, who] = signed[0] as [string, string];
    expect(decode(hex)).toBe(SIWE); // exactly the text the server wrote
    expect(who).toBe(ADDRESS);
    expect(api.calls.find((c) => c.path === '/auth/siwe/challenge')!.body).toEqual({ address: ADDRESS, chainId: 1 });
    expect(api.calls.find((c) => c.path === '/auth/siwe/verify')!.body).toEqual({ message: SIWE, signature: SIGNATURE, ticket: 'ticket-abcdefghijklmnop' });
    expect(sessionStorage.getItem('stryx.codeTicket')).toBeNull(); // used up
    expect(sessionStorage.getItem('stryx.justJoined')).toBe('1'); // Home says "You are in" once
  });

  it("a wrong code gets the server's short message and stays on the code step", async () => {
    installWallet();
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I have one' }));
    fireEvent.change(screen.getByLabelText('Invite code, first four characters'), { target: { value: 'AAAA' } });
    fireEvent.change(screen.getByLabelText('Invite code, last four characters'), { target: { value: 'BBBB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not valid or was already used/);
    expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeTruthy();
  });

  it('a returning wallet signs in with no code; a new wallet there is sent to the code step', async () => {
    installWallet();
    api.handlers['/auth/siwe/verify'] = () => {
      throw new ApiError(403, { error: 'code_required', message: 'This wallet has no account yet. Enter your invite code first.' });
    };
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your wallet' }));
    await pickWallet();
    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/no account yet/);
    expect(api.calls.find((c) => c.path === '/auth/siwe/verify')!.body).not.toHaveProperty('ticket');
  });

  it('a declined signature says so and offers the wallets again', async () => {
    installWallet({ reject: true });
    const { onSignedIn } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your wallet' }));
    await pickWallet();
    expect((await screen.findByRole('alert')).textContent).toMatch(/declined the signature/);
    expect(screen.queryByRole('dialog')).toBeNull(); // the chooser is closed; one button offers it again
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('offers one Connect wallet button, and the chooser lists the wallets in this browser plus ones to install', async () => {
    installWallet();
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your wallet' }));
    expect(screen.queryByRole('button', { name: /Browser wallet/ })).toBeNull(); // no list on the card itself
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect to Stryx', description: 'Sign in with your wallet' });
    expect(await within(dialog).findByRole('button', { name: /Browser wallet/ }, { timeout: 2000 })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: /MetaMask/ }).getAttribute('href')).toBe('https://metamask.io');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.calls.some((c) => c.path.startsWith('/auth/siwe'))).toBe(false); // nothing asked of the server yet
  });

  it('with no wallet in the browser, the chooser says so and links to wallets to install', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with your wallet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/No wallet detected in this browser yet/, undefined, { timeout: 2000 })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: /Rabby/ })).toBeTruthy();
  });

  it('the operator token link shows in development or when a deployment opts in, never otherwise', () => {
    expect(showOperatorLogin({ DEV: true })).toBe(true);
    expect(showOperatorLogin({ DEV: false, VITE_SHOW_OPERATOR_LOGIN: 'true' })).toBe(true);
    expect(showOperatorLogin({ DEV: false })).toBe(false);
    expect(showOperatorLogin({ DEV: false, VITE_SHOW_OPERATOR_LOGIN: 'yes' })).toBe(false);
  });

  it('"Not yet" points to the waitlist and back', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(screen.getByRole('heading', { name: 'Get on the list' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I have a code after all' }));
    expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeTruthy();
  });

  it('a code held from before a reload goes straight to the wallet step', () => {
    sessionStorage.setItem('stryx.codeTicket', JSON.stringify({ ticket: 'ticket-abcdefghijklmnop', expiresAt: Date.now() + 60_000 }));
    renderCard();
    expect(screen.getByRole('heading', { name: 'Code accepted. Now your wallet.' })).toBeTruthy();
  });

  it('"Code needed" on a drop asks for the code', async () => {
    renderCard();
    act(() => {
      window.dispatchEvent(new Event('stryx:ask-code'));
    });
    expect(within(document.body).getByRole('heading', { name: 'Enter your code' })).toBeTruthy();
  });
});
