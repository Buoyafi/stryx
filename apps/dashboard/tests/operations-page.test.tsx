// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../src/lib/api';
import { mintFeedStore } from '../src/lib/mint-feed-store';
import type { ScheduledJob } from '../src/lib/mint-ops';

const CONTRACT = '0x14144295aC06Ccd3F5DD9677E15687823d78ACF9';
const H2 = `0x${'2'.repeat(64)}`;

const api = vi.hoisted(() => ({
  jobs: [] as unknown[],
  jobsError: null as Error | null,
  jobsDelay: 0,
  collectionName: null as string | null,
  calls: [] as { path: string; method: string; body?: unknown }[],
  deleteStatus: 200,
  patchStatus: 200,
  signedJobs: [] as unknown[],
  reports: {} as Record<string, unknown>,
  /** Pages of GET /me/mints by `before` cursor ('' is the first page). Null: the server has no mint log (404). */
  serverPages: null as Record<string, unknown> | null,
  serverError: null as Error | null,
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      const method = options.method ?? 'GET';
      api.calls.push({ path, method, body: options.body });
      if (path.startsWith('/me/mints')) {
        if (api.serverError) throw api.serverError;
        if (!api.serverPages) throw new ApiError(404, { error: 'not_found' });
        const before = new URL(path, 'http://x').searchParams.get('before') ?? '';
        return api.serverPages[before] ?? { mints: [], nextBefore: null };
      }
      if (path === '/signed-mints?mine=1') return { jobs: api.signedJobs };
      if (/^\/signed-mints\/[^/]+\/report$/.test(path)) {
        const id = path.split('/')[2]!;
        if (!(id in api.reports)) throw new ApiError(404, { error: 'x' });
        return api.reports[id];
      }
      if (path.startsWith('/schedules/mints/') && method === 'PATCH') {
        if (api.patchStatus !== 200) throw new ApiError(api.patchStatus, { error: 'schedule_not_editable' });
        return { updated: true };
      }
      if (path === '/schedules/mints?mine=1' && method === 'GET') {
        if (api.jobsDelay) await new Promise((r) => setTimeout(r, api.jobsDelay));
        if (api.jobsError) throw api.jobsError;
        return { jobs: api.jobs };
      }
      if (path === '/wallets') return [{ id: 'w1', address: '0xAAAA00000000000000000000000000000000aaaa' }];
      if (path === '/chains') return { chains: [{ chainId: 46630, name: 'Robinhood Chain Testnet' }] };
      if (path.startsWith('/drops/')) return { openSea: api.collectionName ? { collectionName: api.collectionName } : null };
      if (path.startsWith('/schedules/mints/') && method === 'DELETE') {
        if (api.deleteStatus !== 200) throw new ApiError(api.deleteStatus, { error: 'x' });
        return { cancelled: true };
      }
      throw new Error(`unexpected request in test: ${method} ${path}`);
    }),
  };
});

import { OperationsPage } from '../src/pages/OperationsPage';
import { chooseDateTime } from './helpers/date-time-picker';

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  jobId: '1', kind: 'public', state: 'delayed', walletId: 'w1', nftContract: CONTRACT, chainId: 46630, quantity: 1, executeAt: Date.now() + 3_600_000, ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <OperationsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mintFeedStore.clear();
  Object.assign(api, { jobs: [], jobsError: null, jobsDelay: 0, collectionName: null, calls: [], deleteStatus: 200, patchStatus: 200, signedJobs: [], reports: {}, serverPages: null, serverError: null });
});
afterEach(cleanup);

describe('Operations page: states', () => {
  it('shows loading skeletons for the cards while the schedule list loads', async () => {
    api.jobsDelay = 200;
    renderPage();
    expect(screen.getByLabelText('Loading scheduled mints').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByLabelText('Loading mint history')).not.toBeNull();
    await screen.findByText('No scheduled mints');
  });

  it('shows an empty state for both sections, and says what the history covers', async () => {
    renderPage();
    await screen.findByText('No scheduled mints');
    expect(screen.getByRole('link', { name: /Schedule one from the Mint page/ }).getAttribute('href')).toBe('/mint');
    expect(screen.getByRole('heading', { name: 'Mint history' })).not.toBeNull();
    expect(screen.getByText(/No finished mints yet/)).not.toBeNull();
    expect(screen.getByText(/mints scheduled or fired from this device/)).not.toBeNull(); // no server log: says it is this device only
  });

  it('no longer has Recently finished, Mint outcomes or a live feed', async () => {
    renderPage();
    await screen.findByText('No scheduled mints');
    expect(screen.queryByText(/RECENTLY FINISHED/i)).toBeNull();
    expect(screen.queryByRole('heading', { name: /Mint outcomes/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Live mint feed/ })).toBeNull();
  });

  it('shows a short error with a retry when the schedule list cannot load', async () => {
    api.jobsError = new Error('connect ECONNREFUSED 127.0.0.1:3000 while fetching the list of scheduled mints from the API, which may still be starting up or may have stopped for another reason');
    renderPage();
    const msg = await screen.findByText(/ECONNREFUSED/);
    expect(msg.textContent!.length).toBeLessThanOrEqual(111); // cut to one short line
    expect(msg.closest('.notice')!.getAttribute('title')).toContain('stopped for another reason');
    fireEvent.click(within(msg.closest('.notice') as HTMLElement).getByRole('button', { name: 'Details' })); // the rest is one press away
    expect(msg.textContent).toContain('stopped for another reason');
    expect(screen.getByText('Scheduled jobs could not be loaded.')).not.toBeNull(); // the history says its own, shorter thing
    api.jobsError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No scheduled mints');
  });
});

describe('Operations page: countdown cards', () => {
  it('shows the OpenSea collection name, phase, wallet count, chain and a scheduled state', async () => {
    api.collectionName = 'Robo Cats';
    api.jobs = [job({ jobId: '1', walletId: 'w1' }), job({ jobId: '2', walletId: 'w2', executeAt: Date.now() + 3_600_010 })];
    renderPage();
    const card = await screen.findByRole('article', { name: /Robo Cats/ });
    expect(within(card).getByText('Public')).not.toBeNull();
    expect(within(card).getByText('2 wallets')).not.toBeNull();
    expect(within(card).getByText('scheduled')).not.toBeNull();
    expect(within(card).getByRole('button', { name: 'Robinhood Chain Testnet' })).not.toBeNull(); // the shared ChainIcon
    expect(card.querySelector('.ops-countdown')?.textContent).toMatch(/^(\d+h \d+m \d+s|\d+m \d+s)$/);
  });

  it('falls back to the shortened contract when OpenSea has no name (every testnet)', async () => {
    api.jobs = [job()];
    renderPage();
    expect(await screen.findByRole('article', { name: /Contract 0x1414…ACF9/ })).not.toBeNull();
  });

  it('labels an allow-list job as allow-list and a single wallet in the singular', async () => {
    api.jobs = [job({ kind: 'allowlist-stored' })];
    renderPage();
    const card = await screen.findByRole('article');
    expect(within(card).getByText('Allow-list')).not.toBeNull();
    expect(within(card).getByText('1 wallet')).not.toBeNull();
  });

  it('pulses the countdown, and reads armed, in the final 60 seconds, but not before', async () => {
    api.jobs = [job({ jobId: '1', executeAt: Date.now() + 30_000 }), job({ jobId: '2', nftContract: '0x' + '9'.repeat(40), executeAt: Date.now() + 300_000 })];
    renderPage();
    await screen.findAllByRole('article');
    const cards = screen.getAllByRole('article');
    const final = cards.find((c) => c.querySelector('.ops-countdown.is-final'))!;
    const later = cards.find((c) => !c.querySelector('.ops-countdown.is-final'))!;
    expect(within(final).getByText('armed')).not.toBeNull();
    expect(within(later).getByText('scheduled')).not.toBeNull();
  });

  it('moves a finished run out of Scheduled mints and into Mint history', async () => {
    api.jobs = [job({ state: 'completed', executeAt: Date.now() - 60_000, outcome: { ok: false, reason: 'simulation_reverted', detail: 'PayerNotAllowed(0xabc0000000000000000000000000000000000000) while simulating with the configured endpoint https://rpc.example.com/v2/KEY' } })];
    renderPage();
    await screen.findByText('No scheduled mints');
    expect(document.querySelector('.ops-card')).toBeNull(); // nothing left in Scheduled mints
    expect(screen.getByRole('region', { name: 'Just finished' })).not.toBeNull(); // it ran moments ago, so it also shows up top
    const history = screen.getByRole('region', { name: 'Mint history' });
    expect(within(history).getByText('failed')).not.toBeNull();
    expect(history.querySelector('.history-card__reason')).toBeNull(); // no failure text under a collapsed card
    expect(within(history).queryByText(/PayerNotAllowed/)).toBeNull();
  });

  it('offers "Open in Mint" for the drop, and never an "Arm" action', async () => {
    api.jobs = [job()];
    renderPage();
    const card = await screen.findByRole('article');
    expect(within(card).getByRole('link', { name: 'Open in Mint' }).getAttribute('href')).toBe(`/mint?collection=${CONTRACT}`);
    expect(screen.queryByRole('button', { name: /^arm$/i })).toBeNull();
    expect(screen.queryByText(/disarm/i)).toBeNull();
  });
});

describe('Operations page: Cancel schedule', () => {
  const deletes = () => api.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);

  it('asks first, defaults to keeping the schedule, and sends nothing if you keep it', async () => {
    api.jobs = [job()];
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel schedule' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/cannot be undone/)).not.toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep schedule' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep schedule' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deletes()).toEqual([]);
  });

  it('cancels every job in the batch on confirm, then closes and refreshes the list', async () => {
    api.jobs = [job({ jobId: '7', walletId: 'w1' }), job({ jobId: '8', walletId: 'w2', executeAt: Date.now() + 3_600_010 })];
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel schedule' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel schedule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletes().sort()).toEqual(['/schedules/mints/7', '/schedules/mints/8']);
    expect(api.calls.filter((c) => c.path === '/schedules/mints?mine=1' && c.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('treats a job that is already gone (404) as cancelled', async () => {
    api.jobs = [job()];
    api.deleteStatus = 404;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel schedule' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel schedule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the dialog open with a short message when a cancel really fails', async () => {
    api.jobs = [job()];
    api.deleteStatus = 500;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel schedule' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel schedule' }));
    await screen.findByText(/Cancelled 0 of 1/);
    expect(screen.getByRole('dialog')).not.toBeNull();
  });
});

describe('Operations page: Edit a schedule', () => {
  const patches = () => api.calls.filter((c) => c.method === 'PATCH');

  it('edits the time for every wallet in the card, sending only what changed', async () => {
    api.jobs = [job({ jobId: '7', walletId: 'w1' }), job({ jobId: '8', walletId: 'w2', executeAt: Date.now() + 3_600_010 })];
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    // In the calendar: next month, the 15th, at 07:08.
    const was = new Date((api.jobs[0] as { executeAt: number }).executeAt);
    chooseDateTime(/Runs at/, { monthsAhead: 1, day: 15, hour: 7, minute: 8 });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches().map((c) => c.path).sort()).toEqual(['/schedules/mints/7', '/schedules/mints/8']);
    expect(patches()[0]!.body).toEqual({ executeAt: new Date(was.getFullYear(), was.getMonth() + 1, 15, 7, 8).toISOString() });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Runs at/ })).toBeNull()); // closes on success
  });

  it('changes the quantity per wallet, and cannot save with nothing changed or a bad quantity', async () => {
    api.jobs = [job({ jobId: '7', quantity: 1 })];
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const qty = screen.getByLabelText('Per wallet');
    fireEvent.change(qty, { target: { value: '0' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(qty, { target: { value: '3' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body).toEqual({ quantity: 3 });
  });

  it('keeps the editor open with a short message when the API refuses', async () => {
    api.jobs = [job()];
    api.patchStatus = 409;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Per wallet'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Updated 0 of 1/);
    expect(screen.getByRole('button', { name: /Runs at/ })).not.toBeNull();
  });

  it('offers no Edit on a run that has already started', async () => {
    api.jobs = [job({ state: 'active' })];
    renderPage();
    await screen.findByRole('article');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('Operations page: Cancel all for a drop', () => {
  const deletes = () => api.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);

  it('is offered only when a drop has two or more schedules, and cancels them all', async () => {
    api.jobs = [
      job({ jobId: '1', executeAt: Date.now() + 3_600_000 }),
      job({ jobId: '2', kind: 'allowlist-stored', executeAt: Date.now() + 7_200_000 }),
      job({ jobId: '3', nftContract: '0x' + '9'.repeat(40), executeAt: Date.now() + 3_600_000 }),
    ];
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /Cancel all 2 schedules for this drop/ });
    expect(buttons).toHaveLength(2); // one under each of that drop's two cards, none for the other drop
    fireEvent.click(buttons[0]!);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/2 scheduled mints/)).not.toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel all' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletes().sort()).toEqual(['/schedules/mints/1', '/schedules/mints/2']);
  });

  it('is not offered for a drop with a single schedule', async () => {
    api.jobs = [job()];
    renderPage();
    await screen.findByRole('article');
    expect(screen.queryByRole('button', { name: /Cancel all/ })).toBeNull();
  });
});

describe('Operations page: Mint history', () => {
  const dev = (n: number, over: Record<string, unknown> = {}) => ({
    id: `tx:0x${String(n).repeat(64)}`, at: 1_700_000_000_000 + n * 1000, chainId: 46630, nftContract: CONTRACT, walletId: 'w1', address: '0xAAAA00000000000000000000000000000000aaaa', quantity: 1, hash: `0x${String(n).repeat(64)}`, ...over,
  });
  const history = () => screen.getByRole('region', { name: 'Mint history' });

  it('lists a run with a link to the block explorer, its wallets and its outcome', async () => {
    mintFeedStore.recordMints([dev(1), dev(2, { walletId: 'w2', address: '0xBBBB00000000000000000000000000000000bbbb' })]);
    act(() => mintFeedStore.setReceipts({ [`0x${'1'.repeat(64)}`]: { status: 'success' }, [`0x${'2'.repeat(64)}`]: { status: 'success' } }));
    renderPage();
    const card = await within(history()).findByRole('button', { name: /2 wallets/ });
    expect(within(card).getByText('2 of 2 confirmed')).not.toBeNull();
    expect(card.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(card);
    expect(card.getAttribute('aria-expanded')).toBe('true');
    const legs = screen.getByRole('list', { name: /Wallets for/ });
    const link = within(legs).getAllByRole('link')[0]!;
    expect(link.getAttribute('href')).toMatch(/^https:\/\/explorer\.testnet\.chain\.robinhood\.com\/tx\/0x[12]{64}$/);
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(within(legs).getAllByText('confirmed')).toHaveLength(2);
  });

  it('filters to Successful or Failed, and a run with both shows under both', async () => {
    mintFeedStore.recordMints([
      dev(1), // a good run, an hour before the others
      dev(3, { at: 1_700_100_000_000, nftContract: '0x' + '5'.repeat(40) }),
      dev(4, { at: 1_700_100_001_000, nftContract: '0x' + '5'.repeat(40), hash: undefined, id: 'fail:4', error: 'Insufficient funds' }), // half good, half failed
      dev(5, { at: 1_700_200_000_000, nftContract: '0x' + '6'.repeat(40), hash: undefined, id: 'fail:5', error: 'Not eligible' }), // all failed
    ]);
    act(() => mintFeedStore.setReceipts({ [`0x${'1'.repeat(64)}`]: { status: 'success' }, [`0x${'3'.repeat(64)}`]: { status: 'success' } }));
    renderPage();
    const list = () => within(history()).getByRole('list', { name: /Mint history/ });
    await waitFor(() => expect(within(list()).getAllByRole('button')).toHaveLength(3));
    expect(within(history()).getByText('3 runs')).not.toBeNull();

    fireEvent.click(within(history()).getByRole('radio', { name: 'Successful' }));
    expect(within(list()).getAllByRole('button')).toHaveLength(2); // the good run and the half-good one
    fireEvent.click(within(history()).getByRole('radio', { name: 'Failed' }));
    expect(within(list()).getAllByRole('button')).toHaveLength(2); // the half-good one and the all-failed one
    expect(within(list()).queryByText('Not eligible')).toBeNull(); // the reason only shows once the run is opened
    fireEvent.click(within(history()).getByRole('radio', { name: 'All' }));
    expect(within(list()).getAllByRole('button')).toHaveLength(3);
  });

  it('says so when a filter matches nothing', async () => {
    mintFeedStore.recordMints([dev(1)]);
    act(() => mintFeedStore.setReceipts({ [`0x${'1'.repeat(64)}`]: { status: 'success' } }));
    renderPage();
    await within(history()).findByRole('list', { name: /Mint history/ });
    fireEvent.click(within(history()).getByRole('radio', { name: 'Failed' }));
    expect(within(history()).getByText(/No failed mints/)).not.toBeNull();
  });

  it('marks an on-chain revert as failed, with the reason unavailable', async () => {
    mintFeedStore.recordMints([dev(2)]);
    act(() => mintFeedStore.setReceipts({ [`0x${'2'.repeat(64)}`]: { status: 'reverted', gasUsed: '30000' } }));
    renderPage();
    const card = await within(history()).findByRole('button', { name: /1 wallet/ });
    expect(within(card).getByText('failed')).not.toBeNull();
    fireEvent.click(card);
    expect(history().textContent).toContain('Reverted on-chain (reason not available)');
  });

  it('includes a scheduled job\'s outcome, with the wallet address resolved from the wallet list', async () => {
    api.jobs = [job({ state: 'completed', executeAt: 1_700_000_500_000, outcome: { ok: true, hash: H2 } })];
    renderPage();
    const card = await within(history()).findByRole('button', { name: /1 wallet/ });
    fireEvent.click(card);
    await waitFor(() => expect(history().textContent).toContain('0xAAAA…aaaa'));
  });

  it('shows a finished signed run from its report, with how fast each wallet landed, and leaves out rehearsals and cancelled runs', async () => {
    const signed = (over: Record<string, unknown>) => ({
      jobId: 'sj1', state: 'completed', ownerId: 'u', chainId: 46630, nftContract: CONTRACT, slug: 's', stageUuid: 'st', stageLabel: 'FCFS',
      startMs: 1_700_300_000_000, executeAt: 1_700_300_000_000, wallets: [{ walletId: 'w1', quantity: 3 }, { walletId: 'w2', quantity: 3 }],
      totalQuantity: 6, dryRun: false, simulate: false, rehearsal: false, runStatus: 'completed', ...over,
    });
    api.signedJobs = [signed({}), signed({ jobId: 'sj2', dryRun: true }), signed({ jobId: 'sj3', runStatus: 'cancelled' })];
    const attempt = (walletId: string, status: string, over: Record<string, unknown> = {}) => ({
      walletId, walletAddress: `0x${walletId === 'w1' ? 'a' : 'b'}${'0'.repeat(39)}`, quantity: 3, status, reason: null, detail: null, txHash: null,
      calldataMs: 100, simulatedMs: null, simulateDurationMs: null, signedMs: 200, broadcastMs: 1100, confirmedMs: 1900, notActiveCount: 0, rateLimitedCount: 0, ...over,
    });
    api.reports = { sj1: { run: { jobId: 'sj1', status: 'completed', t0: 'x', dryRun: false, clockSkewed: null, clockSummary: null, notes: null }, attempts: [attempt('w1', 'confirmed', { txHash: `0x${'a'.repeat(64)}` }), attempt('w2', 'failed', { reason: 'not_eligible', confirmedMs: null, broadcastMs: null })] } };
    renderPage();
    const card = await within(history()).findByRole('button', { name: /Signed · FCFS/ });
    expect(within(history()).getAllByRole('button', { name: /Signed/ })).toHaveLength(1);
    await waitFor(() => expect(within(card).getByText('1 of 2 confirmed')).not.toBeNull());
    fireEvent.click(card);
    expect(history().textContent).toContain('1.9s after open');
    expect(history().textContent).toContain('Not eligible for this stage');
  });

  it('pages a long history, twenty runs at a time', async () => {
    mintFeedStore.recordMints(Array.from({ length: 25 }, (_, i) => dev(1, { id: `fail:${i}`, hash: undefined, error: 'x', at: 1_700_000_000_000 + i * 3_600_000, nftContract: '0x' + String(i % 10).repeat(40), chainId: 46630 })));
    renderPage();
    const list = () => within(history()).getByRole('list', { name: /Mint history/ });
    await waitFor(() => expect(within(list()).getAllByRole('button').length).toBe(20));
    fireEvent.click(within(history()).getByRole('button', { name: /Show more/ }));
    expect(within(list()).getAllByRole('button').length).toBeGreaterThan(20);
  });
});

describe('Operations page: history from the account (server mint log)', () => {
  const H = (c: string) => `0x${c.repeat(64)}`;
  const mint = (n: number, over: Record<string, unknown> = {}) => ({
    id: `m${n}`, walletId: 'w1', walletAddress: '0xAAAA00000000000000000000000000000000aaaa', chainId: 46630, contract: CONTRACT, kind: 'PUBLIC', quantity: 1, source: 'MANUAL', jobId: null,
    status: 'CONFIRMED', failureReason: null, failureNote: null, txHash: H(String(n)), gasUsed: '21000',
    createdAt: new Date(1_800_000_000_000 + n * 3_600_000).toISOString(), broadcastAt: new Date(1_800_000_000_000 + n * 3_600_000 + 500).toISOString(), ...over,
  });
  const history = () => screen.getByRole('region', { name: 'Mint history' });
  const cards = () => within(within(history()).getByRole('list', { name: /Mint history/ })).getAllByRole('button');

  it('shows mints made on another device, and says the history is saved to the account', async () => {
    api.serverPages = { '': { mints: [mint(2), mint(1, { status: 'BLOCKED', txHash: null, failureReason: 'no_active_public_stage', failureNote: 'Stage opens later.' })], nextBefore: null, firstAt: mint(1).createdAt } };
    renderPage();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(history().textContent).toContain('Saved to your account, so it is the same on every device you sign in on.');
    expect(history().textContent).not.toContain("this browser's own records");
    fireEvent.click(cards()[1]!);
    expect(history().textContent).toContain('The public stage was not live: Stage opens later.');
  });

  it("keeps this browser's records from before the account's history began, and never shows a mint twice", async () => {
    const firstAt = mint(1).createdAt;
    api.serverPages = { '': { mints: [mint(1)], nextBefore: null, firstAt } };
    mintFeedStore.recordMints([
      // Before the server log: kept.
      { id: 'fail:old', at: Date.parse(firstAt) - 86_400_000, chainId: 46630, nftContract: '0x' + '9'.repeat(40), walletId: 'w1', address: '0xAAAA00000000000000000000000000000000aaaa', quantity: 1, error: 'Old failure' },
      // The same mint the server has: shown once.
      { id: `tx:${H('1')}`, at: Date.parse(firstAt) + 500, chainId: 46630, nftContract: CONTRACT, walletId: 'w1', address: '0xAAAA00000000000000000000000000000000aaaa', quantity: 1, hash: H('1') },
      // A failure after the log began: the server has it (as its own row), so the local copy is dropped.
      { id: 'fail:new', at: Date.parse(firstAt) + 1000, chainId: 46630, nftContract: '0x' + '8'.repeat(40), walletId: 'w1', address: '0xAAAA00000000000000000000000000000000aaaa', quantity: 1, error: 'New failure' },
    ]);
    renderPage();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(history().textContent).toContain("come from this browser's own records");
    expect(history().textContent).not.toContain('New failure');
  });

  it('a mint still pending on the server reads confirmed as soon as this browser has seen its receipt', async () => {
    api.serverPages = { '': { mints: [mint(3, { status: 'PENDING', gasUsed: null })], nextBefore: null, firstAt: mint(3).createdAt } };
    renderPage();
    await waitFor(() => expect(within(history()).getByText('pending')).not.toBeNull());
    act(() => mintFeedStore.setReceipts({ [H('3')]: { status: 'success' } }));
    await waitFor(() => expect(within(history()).getByText('confirmed')).not.toBeNull());
  });

  it('shows a signed run from the log once the server no longer has its report', async () => {
    api.serverPages = { '': { mints: [mint(4, { kind: 'SIGNED', source: 'SCHEDULED', jobId: 'sj1' }), mint(5, { kind: 'SIGNED', source: 'SCHEDULED', jobId: 'sj1', walletId: 'w2', status: 'BLOCKED', txHash: null, failureReason: 'not_eligible' })], nextBefore: null, firstAt: mint(4).createdAt } };
    renderPage();
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]!.textContent).toContain('Signed');
    expect(cards()[0]!.textContent).toContain('1 of 2 confirmed');
  });

  it('loads older mints from the server on request', async () => {
    api.serverPages = {
      '': { mints: [mint(7)], nextBefore: 'cursor-1', firstAt: mint(6).createdAt },
      'cursor-1': { mints: [mint(6, { contract: '0x' + '6'.repeat(40) })], nextBefore: null },
    };
    renderPage();
    await waitFor(() => expect(cards()).toHaveLength(1));
    fireEvent.click(within(history()).getByRole('button', { name: 'Load older mints' }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(api.calls.some((c) => c.path.includes('before=cursor-1'))).toBe(true);
    expect(within(history()).queryByRole('button', { name: 'Load older mints' })).toBeNull();
  });

  it("says so when the account's history cannot be loaded, and shows what this browser kept", async () => {
    api.serverError = new ApiError(503, { error: 'x' });
    mintFeedStore.recordMints([{ id: 'fail:1', at: Date.now() - 60_000, chainId: 46630, nftContract: CONTRACT, walletId: 'w1', address: '0xAAAA00000000000000000000000000000000aaaa', quantity: 1, error: 'Kept here' }]);
    renderPage();
    await within(history()).findByText(/could not be loaded/);
    await waitFor(() => expect(cards()).toHaveLength(1));
  });
});
