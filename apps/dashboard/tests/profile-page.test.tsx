// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { handleProblem, normaliseHandle } from '../src/lib/profile';

const api = vi.hoisted(() => ({
  me: { id: 'u1', email: 'op@stryx.local', role: 'ADMIN', status: 'ACTIVE', displayName: null as string | null, discordHandle: null as string | null, xHandle: null as string | null, createdAt: '2026-09-01T00:00:00Z' },
  patches: [] as unknown[],
  failNext: null as null | { status: number; body: unknown },
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      if (path === '/auth/me') return { ...api.me };
      if (path === '/auth/logout-everywhere') {
        api.patches.push({ logoutEverywhere: true });
        return { ended: 3 };
      }
      if (path === '/me/profile' && options.method === 'PATCH') {
        api.patches.push(options.body);
        if (api.failNext) {
          const f = api.failNext;
          api.failNext = null;
          throw new actual.ApiError(f.status, f.body);
        }
        const b = options.body as { displayName?: string; discordHandle: string; xHandle: string };
        const norm = (v: string, lower: boolean) => { const t = v.trim().replace(/^@+/, ''); return t ? (lower ? t.toLowerCase() : t) : null; };
        api.me = { ...api.me, discordHandle: norm(b.discordHandle, true), xHandle: norm(b.xHandle, false), ...(b.displayName !== undefined ? { displayName: b.displayName.replace(/\s+/g, ' ').trim() || null } : {}) };
        return { ...api.me };
      }
      return {};
    }),
  };
});

import { ProfilePage } from '../src/pages/ProfilePage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProfilePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  api.patches = [];
  api.me = { ...api.me, displayName: null, discordHandle: null, xHandle: null, signedInWith: undefined } as typeof api.me;
});

describe('handle rules (same as the API)', () => {
  it('accepts handles with or without @, and flags the rest', () => {
    expect(handleProblem('discord', '@stryx.ops')).toBeNull();
    expect(handleProblem('discord', '')).toBeNull();
    expect(handleProblem('discord', 'a')).not.toBeNull();
    expect(handleProblem('discord', 'two..dots')).not.toBeNull();
    expect(handleProblem('x', '@stryx_xyz')).toBeNull();
    expect(handleProblem('x', 'far_too_long_for_x')).not.toBeNull();
    expect(handleProblem('x', 'has space')).not.toBeNull();
    expect(normaliseHandle('discord', ' @Stryx.Ops ')).toBe('stryx.ops');
    expect(normaliseHandle('x', '@Stryx_XYZ')).toBe('Stryx_XYZ');
  });
});

describe('Profile page', () => {
  it('shows the account, saves the handles, and says so', async () => {
    renderPage();
    expect(await screen.findByText('Admin')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing changed yet
    fireEvent.change(screen.getByLabelText('Discord'), { target: { value: '@Stryx.Ops' } });
    fireEvent.change(screen.getByLabelText('X'), { target: { value: 'stryx_xyz' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(api.patches).toEqual([{ discordHandle: '@Stryx.Ops', xHandle: 'stryx_xyz' }]);
    await waitFor(() => expect((screen.getByLabelText('Discord') as HTMLInputElement).value).toBe('stryx.ops')); // shows what was stored
    expect(save.disabled).toBe(true);
  });

  it('saves the name greeted on Home, tidied, and flags one that would be refused', async () => {
    renderPage();
    await screen.findByText('Admin');
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'see https://x.y' } });
    expect(screen.getByText(/letters, numbers, spaces/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: ' Ade  Yusuf ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(api.patches).toEqual([{ displayName: ' Ade  Yusuf ', discordHandle: '', xHandle: '' }]);
    await waitFor(() => expect(name.value).toBe('Ade Yusuf'));
  });

  it('"Sign out everywhere" asks first, then ends the sessions; with the API token it says the token still works', async () => {
    api.me = { ...api.me, signedInWith: 'token' } as typeof api.me;
    renderPage();
    await screen.findByText('Admin');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(screen.getByText('Sign out on every device?')).toBeTruthy();
    expect(api.patches).toEqual([]); // nothing sent before confirming
    fireEvent.click(screen.getByRole('button', { name: 'Keep me signed in' }));
    expect(screen.queryByText('Sign out on every device?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Ended 3 wallet sessions\. The API token you are using keeps working/);
    expect(api.patches).toEqual([{ logoutEverywhere: true }]);
  });

  it('flags a bad handle while typing and will not save it', async () => {
    renderPage();
    await screen.findByText('Admin');
    fireEvent.change(screen.getByLabelText('X'), { target: { value: 'has space' } });
    expect(screen.getByText(/up to 15 letters/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.patches).toEqual([]);
  });

  it("shows the server's reason in a contained message when a save is refused", async () => {
    api.failNext = { status: 400, body: { error: 'invalid_profile', message: 'X handles are 1 to 15 characters: letters, numbers and "_".' } };
    renderPage();
    await screen.findByText('Admin');
    fireEvent.change(screen.getByLabelText('X'), { target: { value: 'ok_handle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/X handles are 1 to 15 characters/);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('says subscriptions are not available yet', async () => {
    renderPage();
    expect(await screen.findByText('Coming later')).toBeTruthy();
    expect(screen.getByText(/USDC on Base/)).toBeTruthy();
  });
});
