// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ calls: [] as string[], overview: null as unknown, empty: false, confirmed: false, status: 'ACTIVE', posts: [] as { path: string; body?: unknown }[] }));

const overview = (over: Record<string, unknown> = {}) => ({
  asOf: '2026-10-01T12:00:00Z',
  window: '7d',
  since: '2026-09-24T12:00:00Z',
  dataStartsAt: '2026-09-30T00:00:00Z',
  members: { total: 1284, new: 12, active: 40, activated: 300, suspended: 1, admins: 2 },
  mints: {
    settled: 200, confirmed: 180, reverted: 5, blocked: 14, dropped: 1, pending: 3, successRate: 0.9, healthRate: 0.97,
    failures: { USER: 10, POLICY: 4, INFRA: 0, CHAIN: 6, OTHER: 0 },
    topReasons: [{ reason: 'not_eligible', failureClass: 'USER', count: 10 }, { reason: 'reverted_onchain', failureClass: 'CHAIN', count: 5 }],
  },
  chains: [{ chainId: 8453, settled: 200, confirmed: 180, failed: 20, pending: 3, successRate: 0.9, feeWei: '4200000000000000', burnedWei: '12000000000000' }],
  sources: [{ source: 'SCHEDULED', count: 150 }, { source: 'MANUAL', count: 50 }],
  collections: [{ chainId: 8453, contract: '0x' + 'ab'.repeat(20), mints: 120, confirmed: 110, members: 30 }],
  series: {
    unit: 'day',
    buckets: Array.from({ length: 7 }, (_, i) => ({
      start: new Date(Date.UTC(2026, 8, 25 + i)).toISOString(),
      end: new Date(Date.UTC(2026, 8, 26 + i)).toISOString(),
      confirmed: i === 6 ? 9 : i,
      reverted: i === 6 ? 1 : 0,
      blocked: i === 6 ? 2 : 0,
      failed: i === 6 ? 3 : 0,
      pending: i === 6 ? 1 : 0,
      recorded: i >= 2,
      partial: i === 2,
    })),
  },
  ...over,
});

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      api.calls.push(path);
      if (options.method === 'POST') api.posts.push({ path, body: options.body });
      if (path === '/auth/step-up') {
        api.confirmed = true;
        return { ok: true };
      }
      if (path.startsWith('/admin/members/u-1234567890')) {
        if (!api.confirmed) throw new actual.ApiError(403, { error: 'step_up_required', message: 'Confirm it is you to continue.' });
        if (path.endsWith('/suspend')) {
          api.status = 'SUSPENDED';
          return { status: 'SUSPENDED', sessionsEnded: 2 };
        }
        if (path.endsWith('/unsuspend')) {
          api.status = 'ACTIVE';
          return { status: 'ACTIVE' };
        }
        return {
          member: { id: 'u-1234567890', displayName: 'Tolu', role: 'USER', status: api.status, email: null, discordHandle: 'tolu', xHandle: null, createdAt: '2026-09-30T00:00:00Z' },
          signInWallets: [{ address: '0x' + '1'.repeat(40), addedAt: '2026-09-30T00:00:00Z', lastUsedAt: '2026-10-01T00:00:00Z' }],
          wallets: [{ id: 'w1', address: '0x' + '9'.repeat(40), label: 'Main', tier: 'HOT', status: 'ACTIVE', origin: 'GENERATED', createdAt: '2026-09-30T00:00:00Z' }],
          mints: { settled: 4, confirmed: 3, reverted: 0, blocked: 1, dropped: 0, pending: 0, successRate: 0.75, healthRate: 1, failures: { USER: 1, POLICY: 0, INFRA: 0, CHAIN: 0, OTHER: 0 }, topReasons: [] },
          recentMints: [],
          audit: [{ id: 'a9', createdAt: new Date().toISOString(), action: 'session.login_wallet', actorType: 'USER', actorUserId: 'u-1234567890', actorName: 'Tolu', targetUserId: null, walletId: null, outcome: 'SUCCESS', detail: null }],
        };
      }
      if (path.startsWith('/admin/overview')) return api.overview ?? overview();
      if (path.startsWith('/admin/activity')) {
        return api.empty ? { mints: [], nextBefore: null } : {
          mints: [
            { id: 'm1', ownerId: 'u-1234567890', ownerName: 'Ade', walletAddress: '0x' + '1'.repeat(40), chainId: 8453, contract: '0x' + 'ab'.repeat(20), kind: 'PUBLIC', quantity: 2, source: 'SCHEDULED', status: 'CONFIRMED', failureReason: null, failureNote: null, txHash: '0x' + 'f'.repeat(64), createdAt: new Date().toISOString() },
            { id: 'm2', ownerId: 'u-abcdefghijk', ownerName: null, walletAddress: '0x' + '2'.repeat(40), chainId: 8453, contract: '0x' + 'ab'.repeat(20), kind: 'PUBLIC', quantity: 1, source: 'MANUAL', status: 'BLOCKED', failureReason: 'not_eligible', failureNote: 'OpenSea says no.', txHash: null, createdAt: new Date().toISOString() },
          ],
          nextBefore: 'cursor-1',
        };
      }
      if (path.startsWith('/admin/members')) {
        return { members: [{ id: 'u-1234567890', displayName: 'Ade', role: 'USER', status: 'ACTIVE', createdAt: '2026-09-30T00:00:00Z', signInAddresses: ['0x' + '1'.repeat(40), '0x' + '3'.repeat(40)], wallets: 4, mints: 12, lastMintAt: '2026-10-01T00:00:00Z' }], nextBefore: null };
      }
      if (path.startsWith('/admin/audit')) {
        return { entries: [{ id: 'a1', createdAt: new Date().toISOString(), action: 'role.grant', actorType: 'SYSTEM', actorUserId: null, actorName: null, targetUserId: 'u-1', walletId: null, outcome: 'SUCCESS', detail: 'ADMIN via 0xabc' }], nextBefore: null };
      }
      if (path.startsWith('/drops/')) return { openSea: null };
      return {};
    }),
  };
});

import { AdminPage } from '../src/pages/AdminPage';

function renderAt(url = '/admin') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.calls = [];
  api.posts = [];
  api.confirmed = false;
  api.status = 'ACTIVE';
  api.overview = null;
  api.empty = false;
});
afterEach(cleanup);

describe('Admin: the operator Overview', () => {
  it('opens on the Overview: members, mints, success and platform health, for 7 days', async () => {
    renderAt();
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    const tiles = await screen.findByLabelText('Headline numbers');
    expect(within(tiles).getByText('1,284')).toBeTruthy();
    expect(within(tiles).getByText('12 new in 7 days')).toBeTruthy();
    expect(within(tiles).getByText('90%')).toBeTruthy();
    expect(within(tiles).getByText('97%')).toBeTruthy();
    expect(within(tiles).getByText('3 still pending')).toBeTruthy();
    expect(api.calls).toContain('/admin/overview?window=7d');
  });

  it('switches the period', async () => {
    renderAt();
    await screen.findByLabelText('Headline numbers');
    fireEvent.click(screen.getByRole('radio', { name: '24 hours' }));
    await waitFor(() => expect(api.calls).toContain('/admin/overview?window=24h'));
  });

  it('explains failures by kind and reason, and shows gas per chain in its own token', async () => {
    renderAt();
    const failures = await screen.findByRole('list', { name: 'Failures by kind' });
    expect(within(failures).getByText('Member side')).toBeTruthy();
    expect(within(failures).queryByText('Infrastructure')).toBeNull(); // nothing failed there
    expect(screen.getByRole('list', { name: 'Most common reasons' }).textContent).toContain('Not eligible for this stage');
    const chains = screen.getByRole('region', { name: 'By chain' });
    expect(within(chains).getByText('0.0042 ETH')).toBeTruthy();
    expect(within(chains).getByText('0.000012 ETH')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Top collections' }).textContent).toContain('120');
  });

  it('with nothing settled, says so instead of 0%', async () => {
    api.overview = overview({ mints: { settled: 0, confirmed: 0, reverted: 0, blocked: 0, dropped: 0, pending: 0, successRate: null, healthRate: null, failures: { USER: 0, POLICY: 0, INFRA: 0, CHAIN: 0, OTHER: 0 }, topReasons: [] }, chains: [], sources: [], collections: [] });
    renderAt();
    const tiles = await screen.findByLabelText('Headline numbers');
    expect(within(tiles).getByText('No mints')).toBeTruthy();
    expect(within(tiles).queryByText('0%')).toBeNull();
  });
});

describe('Admin: mints over time', () => {
  it('draws a bar per UTC day with a legend, leaves days before the records unknown, and reads each bar from the keyboard', async () => {
    renderAt();
    const chart = await screen.findByRole('region', { name: 'Mints over time' });
    expect(within(chart).getByText('By day, UTC')).toBeTruthy();
    expect(chart.textContent).toContain('Confirmed');
    expect(chart.textContent).toContain('Before Stryx kept records');
    // The hidden table carries every number, including the unknown days.
    const rows = within(chart).getAllByRole('row');
    expect(rows).toHaveLength(8); // header + 7 days
    expect(rows[1]!.textContent).toContain('Before Stryx kept records');
    expect(rows[7]!.textContent).toMatch(/9.*3.*1.*2.*1 still pending/);
    const plot = within(chart).getByRole('group');
    fireEvent.keyDown(plot, { key: 'End' });
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toMatch(/Thu, Oct 1|Oct 1/);
    expect(tip.textContent).toContain('1 failed on chain · 2 refused before sending');
  });
});

describe('chart helpers', () => {
  it('ticks are whole numbers, at most four steps; empty data still has an axis', async () => {
    const { niceTicks, barLayout } = await import('../src/lib/outcome-chart');
    expect(niceTicks(0)).toEqual({ yMax: 4, ticks: [0, 2, 4] });
    expect(niceTicks(7)).toEqual({ yMax: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceTicks(130).ticks.length).toBeLessThanOrEqual(5);
    const [a, b] = barLayout({ buckets: [{ confirmed: 2, failed: 2 }, { confirmed: 0, failed: 0 }], yMax: 4, plot: { left: 0, top: 0, width: 100, height: 100 } });
    expect(a).toMatchObject({ confirmedHeight: 50, failedHeight: 50, confirmedY: 50, failedY: -2 }); // a 2px gap between the segments
    expect(b).toMatchObject({ confirmedHeight: 0, failedHeight: 0, slotWidth: 50 });
  });
});

describe('formatting', () => {
  it('rates read naturally, and a missing rate is a dash', async () => {
    const { rate, gas, count } = await import('../src/lib/admin-overview');
    expect(rate(0.9)).toBe('90%');
    expect(rate(0.973)).toBe('97.3%');
    expect(rate(1)).toBe('100%');
    expect(rate(0)).toBe('0%');
    expect(rate(null)).toBe('-');
    expect(gas(1, '0')).toBe('0 ETH');
    expect(gas(1, '1234567890000000000')).toBe('1.2345 ETH');
    expect(gas(137, '25000000000000000')).toBe('0.025 POL');
    expect(count(12_900)).toMatch(/12\.9K/);
  });
});

describe('Admin: lists', () => {
  it('Live activity shows every member’s mints with who, which wallet, status and why it failed', async () => {
    renderAt('/admin?tab=activity');
    const list = await screen.findByRole('list', { name: 'Mints, newest first' });
    expect(within(list).getByText('Ade')).toBeTruthy();
    expect(within(list).getByText('Member u-abcdef…')).toBeTruthy();
    expect(within(list).getByText('confirmed')).toBeTruthy();
    expect(within(list).getByText('refused')).toBeTruthy();
    expect(within(list).getByText('Not eligible for this stage: OpenSea says no.')).toBeTruthy();
    expect(within(list).getByRole('link', { name: /0xffff/ }).getAttribute('href')).toContain('/tx/0x');
    // Each row leads with the collection's picture (a monogram here, with no image), its chain as a badge.
    expect(list.querySelectorAll('li .coll-avatar .coll-avatar__chain').length).toBe(list.querySelectorAll('li').length);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() => expect(api.calls.some((c) => c.includes('before=cursor-1'))).toBe(true));
  });

  it('Members lists each account with its sign-in wallets, counts and role', async () => {
    renderAt('/admin?tab=members');
    const list = await screen.findByRole('list', { name: 'Members, newest first' });
    expect(within(list).getByText('Ade')).toBeTruthy();
    expect(list.textContent).toContain('+1'); // a second sign-in wallet
    expect(list.textContent).toContain('4 wallets · 12 mints');
  });

  it('the Audit log reads in words, and filters by kind', async () => {
    renderAt('/admin?tab=audit');
    const list = await screen.findByRole('list', { name: 'Audit log, newest first' });
    expect(within(list).getByText('Made an account admin')).toBeTruthy();
    expect(within(list).getByText('System')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'admin' } });
    await waitFor(() => expect(api.calls).toContain('/admin/audit?limit=100&category=admin'));
  });

  it('tabs work with the arrow keys and keep the open tab in the address', async () => {
    renderAt('/admin?tab=members');
    const members = screen.getByRole('tab', { name: 'Members' });
    expect(members.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(members, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Audit log' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('list', { name: 'Audit log, newest first' })).toBeTruthy();
  });

  it('an empty platform says so', async () => {
    api.empty = true;
    renderAt('/admin?tab=activity');
    expect(await screen.findByText('No mints yet.')).toBeTruthy();
  });
});

describe('Admin: one member', () => {
  it('opens from the list only after confirming, then shows their wallets, mints and record', async () => {
    renderAt('/admin?tab=members');
    fireEvent.click(await screen.findByRole('button', { name: 'Ade' }));
    expect(await screen.findByRole('heading', { name: 'Confirm it’s you' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and open' }));
    fireEvent.change(screen.getByPlaceholderText('API token'), { target: { value: 'op' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('heading', { name: 'Tolu' })).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('Discord @tolu')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Bot wallets' }).textContent).toContain('Main');
    expect(screen.getByRole('list', { name: 'Their audit entries, newest first' }).textContent).toContain('Signed in with a wallet');
    fireEvent.click(screen.getByRole('button', { name: '← All members' }));
    expect(await screen.findByRole('list', { name: 'Members, newest first' })).toBeTruthy();
  });

  it('suspends after asking, with a reason, then can reactivate', async () => {
    api.confirmed = true;
    renderAt('/admin?tab=members&member=u-1234567890');
    await screen.findByRole('heading', { name: 'Tolu' });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend account' }));
    expect(screen.getByText(/signed out on every device/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'abuse report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    expect((await screen.findByRole('status')).textContent).toContain('Suspended. 2 sessions ended.');
    expect(api.posts.find((p) => p.path.endsWith('/suspend'))!.body).toEqual({ reason: 'abuse report' });
    await screen.findByText('suspended');
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect((await screen.findByRole('status')).textContent).toContain('Reactivated');
  });
});
