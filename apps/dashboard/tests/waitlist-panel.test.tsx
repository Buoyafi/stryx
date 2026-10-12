// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  entries: [] as Record<string, unknown>[],
  calls: [] as { path: string; method?: string; body?: unknown }[],
  download: vi.fn(async () => new Blob(['email\n'])),
  failDelete: false,
  inviteEmail: false,
  failSend: false,
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiDownload: (...args: unknown[]) => api.download(...(args as [])),
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      api.calls.push({ path, ...(options.method ? { method: options.method } : {}), ...(options.body !== undefined ? { body: options.body } : {}) });
      if (path.startsWith('/admin/waitlist?status=')) {
        const status = path.split('=')[1];
        const entries = status === 'all' ? api.entries : api.entries.filter((e) => e.status === status);
        return { counts: { waiting: api.entries.filter((e) => e.status === 'waiting').length, invited: api.entries.filter((e) => e.status === 'invited').length }, entries, inviteEmail: api.inviteEmail };
      }
      if (options.method === 'DELETE') {
        if (api.failDelete) throw new actual.ApiError(404, { message: 'That person is no longer on the list.' });
        api.entries = api.entries.filter((e) => !path.includes(String(e.id)));
        return { ok: true };
      }
      if (path.endsWith('/send-invite')) {
        if (api.failSend) throw new actual.ApiError(502, { message: 'The invite email could not be sent, so nobody was marked invited.' });
        api.entries = api.entries.map((e) => (path.includes(`/${String(e.id)}/`) ? { ...e, status: 'invited', invitedAt: '2026-10-09T00:00:00Z' } : e));
        return { entry: {}, expiresAt: '2026-10-23T00:00:00Z' };
      }
      if (path.endsWith('/invited')) {
        const invited = (options.body as { invited: boolean }).invited;
        api.entries = api.entries.map((e) => (path.includes(String(e.id)) ? { ...e, status: invited ? 'invited' : 'waiting', invitedAt: invited ? '2026-10-03T00:00:00Z' : null } : e));
        return { entry: {} };
      }
      return {};
    }),
  };
});

import { AdminPage } from '../src/pages/AdminPage';

const entry = (over: Record<string, unknown>) => ({ id: 'a', email: 'ada@example.com', status: 'waiting', note: null, invitedAt: null, createdAt: '2026-10-02T00:00:00Z', ...over });

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/admin?tab=waitlist']}>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.calls = [];
  api.failDelete = false;
  api.inviteEmail = false;
  api.failSend = false;
  api.download.mockClear();
  api.entries = [entry({}), entry({ id: 'b', email: 'bo@example.com', status: 'invited', invitedAt: '2026-10-03T00:00:00Z' })];
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe('Admin: waitlist', () => {
  it('is its own tab, and lists people with their state and the counts', async () => {
    renderPage();
    const list = await screen.findByRole('list', { name: /waitlist/i });
    expect(within(list).getByText('ada@example.com')).toBeTruthy();
    expect(within(list).getByText('waiting')).toBeTruthy();
    expect(within(list).getByText('invited')).toBeTruthy();
    expect(screen.getByText('1 waiting · 1 invited')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Waitlist' }).getAttribute('aria-selected')).toBe('true');
  });

  it('filters by asking the server for that status', async () => {
    renderPage();
    await screen.findByRole('list', { name: /waitlist/i });
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'invited' } });
    await waitFor(() => expect(api.calls.some((c) => c.path === '/admin/waitlist?status=invited')).toBe(true));
    await waitFor(() => expect(screen.queryByText('ada@example.com')).toBeNull());
    expect(screen.getByText('bo@example.com')).toBeTruthy();
  });

  it('marks someone invited and can undo it', async () => {
    renderPage();
    await screen.findByText('ada@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Mark invited' }));
    await waitFor(() => expect(api.calls).toContainEqual({ path: '/admin/waitlist/a/invited', method: 'POST', body: { invited: true } }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Undo invited' })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo invited' })[0]!);
    await waitFor(() => expect(api.calls.some((c) => c.body && (c.body as { invited: boolean }).invited === false)).toBe(true));
  });

  it('asks before removing, and removes for good only when confirmed', async () => {
    renderPage();
    await screen.findByText('ada@example.com');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(screen.getByText('Remove for good?')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText('Remove for good?')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(api.calls).toContainEqual({ path: '/admin/waitlist/a', method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByText('ada@example.com')).toBeNull());
  });

  it('says plainly when a removal fails', async () => {
    api.failDelete = true;
    renderPage();
    await screen.findByText('ada@example.com');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(await screen.findByText('That person is no longer on the list.')).toBeTruthy();
  });

  it('downloads the CSV through the signed-in download helper', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderPage();
    await screen.findByText('ada@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(api.download).toHaveBeenCalledWith('/admin/waitlist/export'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    click.mockRestore();
  });

  it('offers "Approve & send invite" only when the server can email, and only to people still waiting', async () => {
    renderPage();
    await screen.findByText('ada@example.com');
    expect(screen.queryByRole('button', { name: 'Approve & send invite' })).toBeNull();
    cleanup();
    api.inviteEmail = true;
    renderPage();
    await screen.findByText('ada@example.com');
    expect(screen.getAllByRole('button', { name: 'Approve & send invite' })).toHaveLength(1);
  });

  it('asks before sending, then sends, and says until when the code works', async () => {
    api.inviteEmail = true;
    renderPage();
    await screen.findByText('ada@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Approve & send invite' }));
    expect(screen.getByText('Email them an invite code?')).toBeTruthy();
    expect(api.calls.some((c) => c.path.endsWith('/send-invite'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Email them an invite code?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & send invite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.calls).toContainEqual({ path: '/admin/waitlist/a/send-invite', method: 'POST' }));
    expect(await screen.findByText(/Invite sent\. The code works until/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve & send invite' })).toBeNull());
    expect(api.calls.filter((c) => c.path.endsWith('/send-invite'))).toHaveLength(1);
  });

  it("shows the server's reason when the email could not go out", async () => {
    api.inviteEmail = true;
    api.failSend = true;
    renderPage();
    await screen.findByText('ada@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Approve & send invite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/could not be sent, so nobody was marked invited/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve & send invite' })).toBeTruthy();
  });

  it('shows an empty state when nobody has joined', async () => {
    api.entries = [];
    renderPage();
    expect(await screen.findByText('Nobody has joined yet.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Download CSV' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
