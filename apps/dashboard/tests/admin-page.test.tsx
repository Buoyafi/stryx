// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  off: false,
  codes: [] as Record<string, unknown>[],
  posts: [] as { path: string; body?: unknown }[],
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      if (api.off) throw new actual.ApiError(404, { error: 'not_found' });
      if (path === '/admin/access-codes' && !options.method) return { codes: api.codes };
      if (options.method === 'POST') api.posts.push({ path, body: options.body });
      if (path === '/admin/access-codes') {
        api.codes = [{ id: 'new', label: (options.body as { label?: string }).label ?? null, status: 'unused', boundAddress: null, expiresAt: null, createdAt: '2026-09-30T00:00:00Z', redeemedAt: null, redeemedByAddress: null, revokedAt: null }, ...api.codes];
        return { code: 'STRYX-7K2P-QX9M', id: 'new', expiresAt: null };
      }
      if (path.endsWith('/revoke')) {
        api.codes = api.codes.map((c) => (path.includes(String(c.id)) ? { ...c, status: 'revoked' } : c));
        return { ok: true };
      }
      return {};
    }),
  };
});

import { AdminPage } from '../src/pages/AdminPage';

const row = (over: Record<string, unknown>) => ({ id: 'a', label: 'Ada', status: 'unused', boundAddress: null, expiresAt: '2026-10-30T00:00:00Z', createdAt: '2026-09-29T00:00:00Z', redeemedAt: null, redeemedByAddress: null, revokedAt: null, ...over });

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/admin?tab=codes']}>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.off = false;
  api.posts = [];
  api.codes = [row({}), row({ id: 'b', label: 'Bo', status: 'used', redeemedByAddress: '0x' + 'cd'.repeat(20), redeemedAt: '2026-09-30T00:00:00Z' })];
});
afterEach(cleanup);

describe('Admin: invite codes', () => {
  it('lists codes with their state, and who used one; never the code itself', async () => {
    renderPage();
    const list = await screen.findByRole('list');
    expect(within(list).getByText('Ada')).toBeTruthy();
    expect(within(list).getByText('unused')).toBeTruthy();
    expect(within(list).getByText(/Used by 0xcdcd…cdcd/)).toBeTruthy();
    expect(screen.getByText('1 unused of 2')).toBeTruthy();
    expect(screen.queryByText(/STRYX-/)).toBeNull();
  });

  it('makes a code and shows it once, to copy', async () => {
    renderPage();
    await screen.findByRole('list');
    fireEvent.change(screen.getByLabelText('Who it is for (optional)'), { target: { value: '@newfriend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    expect(await screen.findByText('STRYX-7K2P-QX9M')).toBeTruthy();
    expect(api.posts[0]).toEqual({ path: '/admin/access-codes', body: { label: '@newfriend', expiresInDays: 30 } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('STRYX-7K2P-QX9M')).toBeNull();
    await waitFor(() => expect(screen.getByText('@newfriend')).toBeTruthy());
  });

  it('will not send an address that is not one', async () => {
    renderPage();
    await screen.findByRole('list');
    fireEvent.change(screen.getByLabelText('Only for this wallet (optional)'), { target: { value: '0x123' } });
    expect(screen.getByText('That is not a wallet address.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Make a code' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('revokes an unused code after a second click, and offers nothing for a used one', async () => {
    renderPage();
    const list = await screen.findByRole('list');
    const [ada, bo] = within(list).getAllByRole('listitem');
    expect(within(bo!).queryByRole('button', { name: 'Revoke' })).toBeNull();
    fireEvent.click(within(ada!).getByRole('button', { name: 'Revoke' }));
    expect(within(ada!).getByText('Revoke this code?')).toBeTruthy();
    expect(api.posts).toEqual([]); // not yet
    fireEvent.click(within(ada!).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.posts).toEqual([{ path: '/admin/access-codes/a/revoke', body: undefined }]));
    expect(await screen.findByText('revoked')).toBeTruthy();
  });

  it('says so when invite codes are off on this server', async () => {
    api.off = true;
    renderPage();
    expect(await screen.findByText(/Invite codes are off on this server/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make a code' })).toBeNull();
  });
});
