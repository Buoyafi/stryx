// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  me: null as null | Record<string, unknown>,
  meError: false,
  patches: [] as unknown[],
  patchError: null as null | { status: number; body: unknown },
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: Record<string, unknown> } = {}) => {
      if (path === '/auth/me') {
        if (api.meError) throw new actual.ApiError(500, { error: 'internal_server_error' });
        return api.me;
      }
      if (path === '/me/profile' && options.method === 'PATCH') {
        api.patches.push(options.body);
        if (api.patchError) throw new actual.ApiError(api.patchError.status, api.patchError.body);
        api.me = { ...api.me, ...options.body, displayName: String(options.body?.displayName ?? '').replace(/\s+/g, ' ').trim() || null };
        return api.me;
      }
      throw new Error(`unexpected ${path}`);
    }),
  };
});

import { MemberCard, greeting } from '../src/components/MemberCard';

const account = (over: Record<string, unknown> = {}) => ({ id: 'u1', email: null, role: 'USER', status: 'ACTIVE', displayName: null, discordHandle: null, xHandle: null, createdAt: '2026-09-30T00:00:00Z', signedInWith: 'wallet', ...over });

function renderCard(justJoined = false, now = new Date(2026, 9, 1, 20, 0)) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <MemberCard justJoined={justJoined} now={now} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.assign(api, { me: account(), meError: false, patches: [], patchError: null });
});
afterEach(cleanup);

describe('Home card for a signed-in member', () => {
  it('greets a returning member by their saved name, with the time of day', async () => {
    api.me = account({ displayName: 'Ade' });
    renderCard(false, new Date(2026, 9, 1, 9, 30));
    expect(await screen.findByRole('heading', { name: 'Welcome back, Ade.' })).toBeTruthy();
    expect(screen.getByText('Good morning')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mint a drop' }).getAttribute('href')).toBe('/mint');
    // A saved name is changed on Profile, not from this card.
    expect(screen.queryByRole('button', { name: /your name/i })).toBeNull();
  });

  it('right after joining it asks for a name, saves it to the account, then greets them by it', async () => {
    renderCard(true);
    expect(await screen.findByRole('heading', { name: 'You are in.' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '  Ade   Yusuf ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'You are in, Ade Yusuf.' })).toBeTruthy();
    expect(api.patches).toEqual([{ displayName: 'Ade Yusuf' }]); // only the name is sent
    expect(screen.getByRole('link', { name: 'Create your first wallet' }).getAttribute('href')).toBe('/wallets');
  });

  it('a member with no name is welcomed back plainly, and can add one', async () => {
    renderCard(false);
    expect(await screen.findByRole('heading', { name: 'Welcome back.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add your name' }));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Tolu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back, Tolu.' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /your name/i })).toBeNull();
  });

  it('checks the name while typing, and cannot save one the server would refuse', async () => {
    renderCard(true);
    const input = await screen.findByLabelText('Your name');
    fireEvent.change(input, { target: { value: '<b>hi</b>' } });
    expect(screen.getByText(/letters, numbers, spaces/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'x'.repeat(33) } });
    expect(screen.getByText(/32 characters or fewer/)).toBeTruthy();
    expect(api.patches).toEqual([]);
  });

  it("shows the server's short message when saving fails, and keeps what was typed", async () => {
    api.patchError = { status: 400, body: { error: 'invalid_profile', message: 'Keep your name to 32 characters or fewer.' } };
    renderCard(true);
    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Ade' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/32 characters/);
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Ade');
  });

  it('a name is shown as text, never as markup', async () => {
    api.me = account({ displayName: '<img src=x onerror=alert(1)>' });
    const { container } = renderCard();
    await screen.findByRole('heading', { name: /Welcome back/ });
    expect(container.querySelector('img')).toBeNull();
  });

  it('stays out of the way if the account cannot be loaded', async () => {
    api.meError = true;
    const { container } = renderCard();
    await waitFor(() => expect(container.querySelector('[aria-busy]')).toBeNull());
    expect(container.querySelector('.welcome')).toBeNull();
  });

  it('says good morning, afternoon or evening by the clock', () => {
    expect(greeting(8)).toBe('Good morning');
    expect(greeting(13)).toBe('Good afternoon');
    expect(greeting(21)).toBe('Good evening');
    expect(greeting(2)).toBe('Up late');
  });
});
