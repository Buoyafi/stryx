// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const calls: { path: string; method?: string; body?: unknown }[] = [];
let responder: (path: string, method: string | undefined, body: unknown) => unknown = () => {
  throw new Error('unexpected call');
};

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      calls.push({ path, method: options.method, body: options.body });
      return responder(path, options.method, options.body);
    }),
  };
});
const charge = vi.fn();
vi.mock('../src/lib/brand', () => ({ chargeLogo: () => charge() }));

import { SignedMintPanel } from '../src/components/mint/SignedMintPanel';
import { SignedMintCard } from '../src/components/SignedMintCard';
import { attemptCounts, botTimeMs, botTimeSummary, describeAttemptReason, newlyConfirmed, signedRefetchInterval, type SignedMintJob } from '../src/lib/signed-mint';
import { chooseQuick } from './helpers/date-time-picker';

const NOW = Date.now();
const PHASE = {
  id: 'opensea-1',
  name: 'FCFS',
  kind: 'allowlist' as const,
  priceWei: '1000000000000000',
  startMs: NOW + 3_600_000,
  endMs: NOW + 7_200_000,
  maxPerWallet: 2,
  source: 'opensea' as const,
  mechanism: 'signed' as const,
  openSeaStageUuid: 'stage-uuid',
};
const WALLETS = [
  { id: 'w1', address: '0x1111111111111111111111111111111111111a', label: null },
  { id: 'w2', address: '0x2222222222222222222222222222222222222b', label: 'Team' },
];

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const enabled = { executionEnabled: true, retryIntervalMs: 250, giveUpMs: 60_000 };

beforeEach(() => {
  calls.length = 0;
  charge.mockClear();
});
afterEach(cleanup);

describe('SignedMintPanel', () => {
  const mountPanel = (phase = PHASE) =>
    wrap(<SignedMintPanel phase={phase} chainId={4663} contract="0xc62caba0cf5774d8e40e2651e86a0014de8ab768" slug="kid-story" wallets={WALLETS} symbol="ETH" eligibility={new Map()} />);

  it('schedules the chosen wallets with their own quantities, the stage price as the cap, simulation on, real run', async () => {
    responder = (path, method) => {
      if (path === '/signed-mints/status') return enabled;
      if (path === '/signed-mints' && method === 'POST') return { jobId: 'signed-1', startAt: new Date(PHASE.startMs).toISOString(), stageLabel: 'FCFS', rehearsal: false };
      throw new Error(`unexpected ${path}`);
    };
    mountPanel();
    fireEvent.click(await screen.findByLabelText(`Select ${WALLETS[0]!.address}`));
    fireEvent.click(screen.getByLabelText('Select Team'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Increase quantity' })[0]!); // w1 -> 2

    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(await screen.findByText(/a higher signed price is refused/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and schedule' }));

    expect(await screen.findByText(/Scheduled: FCFS at/)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      chainId: 4663,
      nftContract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768',
      slug: 'kid-story',
      stageUuid: 'stage-uuid',
      wallets: [
        { walletId: 'w1', quantity: 2 },
        { walletId: 'w2', quantity: 1 },
      ],
      maxPriceWei: '1000000000000000',
      simulate: true,
      dryRun: false,
      maxSpendWei: null,
    });
  });

  it('dry run with simulation off and a spend limit are all carried through', async () => {
    responder = (path, method) => {
      if (path === '/signed-mints/status') return enabled;
      if (method === 'POST') return { jobId: 'signed-1', startAt: new Date(PHASE.startMs).toISOString(), stageLabel: 'FCFS', rehearsal: false };
      throw new Error(`unexpected ${path}`);
    };
    mountPanel();
    fireEvent.click(await screen.findByLabelText(`Select ${WALLETS[0]!.address}`));
    fireEvent.click(screen.getByRole('switch', { name: 'Dry run' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Simulate before sending' }));
    fireEvent.change(screen.getByPlaceholderText('none'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule dry run' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm dry run' }));
    await screen.findByText(/Scheduled/);
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ dryRun: true, simulate: false, maxSpendWei: '500000000000000000' });
  });

  it('says plainly when the kill switch is off, and offers nothing to schedule', async () => {
    responder = () => ({ ...enabled, executionEnabled: false });
    mountPanel();
    expect(await screen.findByText(/Signed minting is switched off on the server/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Schedule' })).toBeNull();
  });

  it('a live stage offers "Mint now": it fires straight away, as a real mint, with the same checks', async () => {
    responder = (path, method) => {
      if (path === '/signed-mints/status') return enabled;
      if (method === 'POST') return { jobId: 'signed-9', startAt: new Date(NOW + 2_000).toISOString(), stageLabel: 'GTD', rehearsal: false, immediate: true };
      throw new Error(`unexpected ${path}`);
    };
    mountPanel({ ...PHASE, name: 'GTD', startMs: NOW - 600_000 });
    fireEvent.click(await screen.findByLabelText(`Select ${WALLETS[0]!.address}`));
    fireEvent.click(screen.getByRole('button', { name: 'Mint now' }));
    expect(await screen.findByText('Now: the stage is live')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and mint now' }));
    expect(await screen.findByText(/Firing now: GTD/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ fireNow: true, dryRun: false, simulate: true, wallets: [{ walletId: 'w1', quantity: 1 }] });
  });

  it('a live stage can also be a dry run now, or a rehearsal at a picked time (then it is not "now")', async () => {
    responder = () => enabled;
    mountPanel({ ...PHASE, startMs: NOW - 600_000 });
    fireEvent.click(await screen.findByLabelText(`Select ${WALLETS[0]!.address}`));
    fireEvent.click(screen.getByRole('switch', { name: 'Dry run' }));
    expect(screen.getByRole('button', { name: 'Dry run now' })).toBeTruthy();
    chooseQuick(/Rehearse at/, 'In 1 hour');
    expect(screen.getByRole('button', { name: 'Schedule dry run' })).toBeTruthy();
  });

  it('an ended stage only allows a dry-run rehearsal at a picked time', async () => {
    responder = () => enabled;
    mountPanel({ ...PHASE, startMs: NOW - 7_200_000, endMs: NOW - 60_000 });
    expect(await screen.findByText(/This stage has ended/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Dry run' }));
    fireEvent.click(await screen.findByLabelText(`Select ${WALLETS[0]!.address}`));
    expect((screen.getByRole('button', { name: 'Schedule dry run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The stage has ended: only a dry-run rehearsal at a picked time is possible.')).toBeTruthy();
  });

  it('surfaces the server refusing to schedule, in its own words', async () => {
    const { ApiError } = await import('../src/lib/api');
    responder = (path, method) => {
      if (path === '/signed-mints/status') return enabled;
      if (method === 'POST') throw new ApiError(409, { error: 'cannot_schedule_signed_mint', reason: 'outside_onchain_bounds', message: "OpenSea's window for \"FCFS\" falls outside every on-chain signer's allowed start/end." });
      throw new Error('unexpected');
    };
    mountPanel();
    fireEvent.click(await screen.findByLabelText(`Select ${WALLETS[0]!.address}`));
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and schedule' }));
    expect(await screen.findByText(/falls outside every on-chain signer/)).toBeTruthy();
  });
});

const JOB: SignedMintJob = {
  jobId: 'signed-1',
  state: 'delayed',
  ownerId: 'o',
  chainId: 4663,
  nftContract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768',
  slug: 'kid-story',
  stageUuid: 'stage-uuid',
  stageLabel: 'FCFS',
  startMs: NOW + 90_000,
  executeAt: NOW + 85_000,
  wallets: [
    { walletId: 'w1', quantity: 2 },
    { walletId: 'w2', quantity: 1 },
  ],
  totalQuantity: 3,
  dryRun: false,
  simulate: true,
  rehearsal: false,
  runStatus: 'scheduled',
};

const attempt = (walletId: string, status: string, extra: Record<string, unknown> = {}) => ({
  walletId,
  walletAddress: '0x1111111111111111111111111111111111111a',
  quantity: 1,
  status,
  reason: null,
  detail: null,
  txHash: null,
  calldataMs: 20,
  simulatedMs: 40,
  simulateDurationMs: 18,
  signedMs: 44,
  broadcastMs: 60,
  confirmedMs: null,
  notActiveCount: 3,
  rateLimitedCount: 0,
  ...extra,
});

describe('SignedMintCard', () => {
  it('counts down to the stage start and cancels through the signed-mint route after a confirm step', async () => {
    responder = (path, method) => {
      if (method === 'DELETE' && path === '/signed-mints/signed-1') return { jobId: 'signed-1', result: 'cancelled' };
      if (path === '/collections/4663/0xc62caba0cf5774d8e40e2651e86a0014de8ab768' || path.startsWith('/drops/')) return {};
      throw new Error(`unexpected ${path}`);
    };
    wrap(<SignedMintCard job={JOB} now={NOW} />);
    expect(screen.getByRole('timer').textContent).toMatch(/1m 30s|01:30|1:30/);
    expect(screen.getByText(/Signed · FCFS/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel schedule' }));
    expect(screen.getByText('Cancel this schedule?')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel schedule' }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/signed-mints/signed-1')).toBe(true));
  });

  it('after the run: per-wallet status, plain reasons and timings; the clock warning when skewed', async () => {
    responder = (path) => {
      if (path === '/signed-mints/signed-1/report') {
        return {
          run: { jobId: 'signed-1', status: 'finished', t0: new Date(NOW).toISOString(), dryRun: false, clockSkewed: true, clockSummary: 'x', notes: null },
          attempts: [attempt('w1', 'confirmed', { confirmedMs: 410, txHash: '0x' + 'ab'.repeat(32) }), attempt('w2', 'failed', { reason: 'not_eligible', calldataMs: null, broadcastMs: null })],
        };
      }
      return {};
    };
    wrap(<SignedMintCard job={{ ...JOB, state: 'completed', runStatus: 'finished' }} now={NOW} />);
    expect(await screen.findByText('1 confirmed, 1 failed')).toBeTruthy();
    expect(screen.getByText('Not eligible for this stage')).toBeTruthy();
    expect(screen.getByText('410')).toBeTruthy();
    expect(screen.getByText('Bot time 40 ms')).toBeTruthy(); // calldata 20 -> sent 60, the one wallet that sent
    expect(screen.getByText(/Server clock was over 1s off at warm-up/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel schedule' })).toBeNull();
    expect(charge).not.toHaveBeenCalled(); // already confirmed on first sight: not a live confirmation
  });

  it('replays the logo animation when a wallet becomes confirmed between polls', async () => {
    let status = 'broadcast';
    responder = (path) => {
      if (path === '/signed-mints/signed-1/report') {
        return { run: { jobId: 'signed-1', status: 'fetching', t0: '', dryRun: false, clockSkewed: false, clockSummary: null, notes: null }, attempts: [attempt('w1', status)] };
      }
      return {};
    };
    wrap(<SignedMintCard job={{ ...JOB, state: 'active', runStatus: 'fetching' }} now={NOW} />);
    await screen.findByText('1 sent');
    status = 'confirmed';
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1_200));
    });
    await waitFor(() => expect(charge).toHaveBeenCalledTimes(1));
  });
});

describe('SignedMintCard after a run ends', () => {
  it('fetches the report once more when the job stops running', async () => {
    let status = 'pending';
    responder = (path) => {
      if (path === '/signed-mints/signed-1/report') {
        return { run: { jobId: 'signed-1', status: 'finished', t0: '', dryRun: false, clockSkewed: false, clockSummary: null, notes: null }, attempts: [attempt('w1', status)] };
      }
      return {};
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const card = (state: 'active' | 'completed') => (
      <QueryClientProvider client={client}>
        <SignedMintCard job={{ ...JOB, state, runStatus: state === 'active' ? 'fetching' : 'finished' }} now={NOW} />
      </QueryClientProvider>
    );
    const { rerender } = render(card('active'));
    await screen.findByText('1 pending');
    status = 'failed';
    rerender(card('completed'));
    expect(await screen.findByText('1 failed')).toBeTruthy();
  });
});

describe('signed-mint helpers', () => {
  it('attemptCounts lists only non-zero statuses, in a fixed order', () => {
    expect(attemptCounts([{ status: 'failed' }, { status: 'confirmed' }, { status: 'confirmed' }])).toBe('2 confirmed, 1 failed');
  });
  it('newlyConfirmed ignores the first poll and reports only transitions', () => {
    const rows = [attempt('w1', 'confirmed'), attempt('w2', 'confirmed')] as never;
    expect(newlyConfirmed(null, rows)).toEqual([]);
    expect(newlyConfirmed(new Map([['w1', 'confirmed'], ['w2', 'broadcast']]), rows)).toEqual(['w2']);
  });
  it('polls fast while a run is close or running', () => {
    expect(signedRefetchInterval([JOB], NOW)).toBe(2_000);
    expect(signedRefetchInterval([{ ...JOB, startMs: NOW + 3_600_000 }], NOW)).toBe(15_000);
  });
  it('describes reason codes in plain words, falling back to the code', () => {
    expect(describeAttemptReason('gave_up')).toBe('Gave up waiting for the stage');
    expect(describeAttemptReason('something_new')).toBe('something_new');
  });
  it('bot time runs from calldata to sent (to simulated for a dry run), and summarises across wallets', () => {
    expect(botTimeMs(attempt('w1', 'confirmed') as never)).toBe(40);
    expect(botTimeMs(attempt('w1', 'dry_run_ok', { broadcastMs: null }) as never)).toBe(20);
    expect(botTimeMs(attempt('w1', 'failed', { calldataMs: null }) as never)).toBeNull();
    const rows = [attempt('a', 'confirmed', { broadcastMs: 50 }), attempt('b', 'confirmed', { broadcastMs: 90 }), attempt('c', 'confirmed', { broadcastMs: 70 })] as never;
    expect(botTimeSummary(rows)).toBe('Bot time: median 50 ms (fastest 30, slowest 70)');
    expect(botTimeSummary([])).toBeNull();
  });
});
