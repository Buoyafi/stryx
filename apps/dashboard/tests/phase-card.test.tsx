// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../src/lib/api';

const calls: { path: string; body?: unknown }[] = [];
let responder: (path: string, body: unknown) => unknown = () => {
  throw new Error('unexpected call');
};

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      calls.push({ path, body: options.body });
      return responder(path, options.body);
    }),
  };
});

import { PhaseCard } from '../src/components/mint/PhaseCard';

const NOW = Date.now();
const CHAIN_ID = 46630;
const CONTRACT = '0xAbc';

const LIVE_PHASE = { id: 'public', name: 'Public', kind: 'public' as const, priceWei: (10n ** 16n).toString(), startMs: NOW - 60_000, endMs: NOW + 3_600_000, maxPerWallet: 5, source: 'on-chain' as const, mechanism: null, openSeaStageUuid: null };
const ALLOWLIST_PHASE = { id: 'opensea-1', name: 'OG List', kind: 'allowlist' as const, priceWei: '5000000000000000', startMs: NOW - 60_000, endMs: NOW + 7_200_000, maxPerWallet: 2, source: 'opensea' as const, mechanism: 'merkle' as const, openSeaStageUuid: 'uuid-og' };

const WALLET_A = { id: 'w1', address: '0x1111111111111111111111111111111111111a', label: null };
const WALLET_B = { id: 'w2', address: '0x2222222222222222222222222222222222222b', label: 'Team' };
const WALLET_C = { id: 'w3', address: '0x3333333333333333333333333333333333333c', label: null };

function mount(props: Partial<React.ComponentProps<typeof PhaseCard>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PhaseCard phase={LIVE_PHASE} symbol="ETH" usdPerToken={null} showUsd={false} chainId={CHAIN_ID} contract={CONTRACT} slug="lunar-lemurs" wallets={[WALLET_A, WALLET_B, WALLET_C]} {...props} />
    </QueryClientProvider>,
  );
}

const open = () => fireEvent.click(screen.getByRole('button', { expanded: false }));

beforeEach(() => {
  calls.length = 0;
  responder = () => {
    throw new Error('unexpected call');
  };
});
afterEach(cleanup);

describe('PhaseCard', () => {
  it('a stage priced in an ERC-20 is never shown as ETH', async () => {
    responder = () => ({ results: [] });
    mount({ phase: { ...LIVE_PHASE, priceToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', priceWei: '5000000' }, showUsd: true, usdPerToken: 3000 });
    expect(await screen.findByText(/Paid in token 0xA0b8/)).toBeTruthy();
    expect(screen.queryByText(/ETH/)).toBeNull();
  });

  it('checks eligibility on mount, before the card is ever expanded, so the chip reads a real count without a click', async () => {
    responder = () => ({
      results: [
        { walletId: 'w1', address: WALLET_A.address, balanceWei: '1000000000000000000', minted: 1, limit: 5, remaining: 4, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei },
        { walletId: 'w2', address: WALLET_B.address, balanceWei: '0', minted: 5, limit: 5, remaining: 0, eligible: 'not_eligible', reason: 'at_mint_limit', priceWei: LIVE_PHASE.priceWei },
        { walletId: 'w3', address: WALLET_C.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'not_eligible', reason: 'not_on_allowlist', priceWei: LIVE_PHASE.priceWei },
      ],
    });
    mount();
    await screen.findByText('Public');

    const call = await waitFor(() => calls.find((c) => c.path.endsWith('/eligibility'))!);
    expect(call.body).toMatchObject({ slug: 'lunar-lemurs', walletIds: ['w1', 'w2', 'w3'], phase: LIVE_PHASE });
    expect(await screen.findByText('1/3')).toBeTruthy(); // the chip, while the card is still collapsed
  });

  it('shows the real per-wallet detail once expanded, reusing the mount-time fetch rather than re-checking', async () => {
    responder = () => ({
      results: [
        { walletId: 'w1', address: WALLET_A.address, balanceWei: '1000000000000000000', minted: 1, limit: 5, remaining: 4, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei },
        { walletId: 'w2', address: WALLET_B.address, balanceWei: '0', minted: 5, limit: 5, remaining: 0, eligible: 'not_eligible', reason: 'at_mint_limit', priceWei: LIVE_PHASE.priceWei },
        { walletId: 'w3', address: WALLET_C.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'not_eligible', reason: 'not_on_allowlist', priceWei: LIVE_PHASE.priceWei },
      ],
    });
    mount();
    await screen.findByText('1/3'); // fetch already resolved before the click
    const eligibilityCallsBeforeOpen = calls.filter((c) => c.path.endsWith('/eligibility')).length;
    open();

    expect(screen.getByText(/Team ·/)).toBeTruthy(); // labelled wallet shows its label
    expect(screen.getByText(/Limit reached/)).toBeTruthy();
    expect(screen.getByText(/Not on list/)).toBeTruthy();
    expect(calls.filter((c) => c.path.endsWith('/eligibility'))).toHaveLength(eligibilityCallsBeforeOpen); // no re-fetch on expand
  });

  it('auto-selects only the eligible wallets, leaving quantities at 0 until set', async () => {
    responder = () => ({
      results: [
        { walletId: 'w1', address: WALLET_A.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei },
        { walletId: 'w2', address: WALLET_B.address, balanceWei: '0', minted: 5, limit: 5, remaining: 0, eligible: 'not_eligible', reason: 'at_mint_limit', priceWei: LIVE_PHASE.priceWei },
        { walletId: 'w3', address: WALLET_C.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei },
      ],
    });
    mount();
    await screen.findByText('Public');
    open();
    await screen.findByText('2/3');

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.filter((c) => c.checked)).toHaveLength(2); // w1 and w3, not the ineligible w2
    expect(checkboxes.find((c) => c.disabled)).toBeTruthy(); // w2's checkbox is disabled

    expect(screen.getByText(/0 NFTs · 0 wallets/)).toBeTruthy(); // nothing selected has a quantity yet
  });

  it('"Max selected" fills every selected eligible wallet to its own remaining, and totals the summary', async () => {
    responder = () => ({
      results: [
        { walletId: 'w1', address: WALLET_A.address, balanceWei: '1000000000000000000', minted: 0, limit: 5, remaining: 3, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei },
        { walletId: 'w2', address: WALLET_B.address, balanceWei: '1000000000000000000', minted: 0, limit: 5, remaining: 2, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei },
        { walletId: 'w3', address: WALLET_C.address, balanceWei: '0', minted: 5, limit: 5, remaining: 0, eligible: 'not_eligible', reason: 'at_mint_limit', priceWei: LIVE_PHASE.priceWei },
      ],
    });
    mount();
    await screen.findByText('Public');
    open();
    await screen.findByText('2/3');

    fireEvent.click(screen.getByRole('button', { name: 'Max selected' }));
    expect(await screen.findByText(/5 NFTs · 2 wallets/)).toBeTruthy(); // 3 + 2
    expect(screen.getByText(/0\.05 ETH/)).toBeTruthy(); // 5 * 0.01 ETH

    fireEvent.click(screen.getByRole('button', { name: 'Set 1' }));
    expect(await screen.findByText(/2 NFTs · 2 wallets/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText(/0 NFTs · 0 wallets/)).toBeTruthy();
  });

  it('the primary button starts disabled until a quantity is actually set for a selected wallet', async () => {
    responder = () => ({ results: [{ walletId: 'w1', address: WALLET_A.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei }] });
    mount({ wallets: [WALLET_A] });
    await screen.findByText('Public');
    open();
    await screen.findByText('1/1');

    const button = screen.getByRole('button', { name: 'Mint now' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); // w1 is auto-selected but its quantity is still 0
    expect(button.title).toBe('Select at least one wallet and set a quantity first');
  });

  it('firing a live public phase opens the review step, fires /mints/seadrop/batch, and shows the results', async () => {
    responder = (path) => {
      if (path.endsWith('/eligibility')) {
        return { results: [{ walletId: 'w1', address: WALLET_A.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei }] };
      }
      if (path === '/mints/seadrop/batch') {
        return { ok: true, results: [{ walletId: 'w1', address: WALLET_A.address, status: 'sent', quantity: 1, hash: '0xabc' }] };
      }
      throw new Error(`unexpected ${path}`);
    };
    mount({ wallets: [WALLET_A] });
    await screen.findByText('Public');
    open();
    await screen.findByText('1/1');
    fireEvent.click(screen.getByRole('button', { name: 'Set 1' }));

    const button = screen.getByRole('button', { name: 'Mint now' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Confirm and mint' })).toBeTruthy();
    expect(screen.getByText('Nothing is sent until you press this.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and mint' }));

    expect(await screen.findByText('1/1 wallet succeeded.')).toBeTruthy();
    const batchCall = calls.find((c) => c.path === '/mints/seadrop/batch');
    expect(batchCall?.body).toMatchObject({ stage: 'public', quantity: 1, walletIds: ['w1'] });
  });

  it('firing an upcoming Merkle phase opens the review step in schedule mode and calls /schedules/mints', async () => {
    responder = (path) => {
      if (path.endsWith('/eligibility')) {
        return { results: [{ walletId: 'w1', address: WALLET_A.address, balanceWei: '0', minted: 0, limit: 2, remaining: 2, eligible: 'eligible', priceWei: ALLOWLIST_PHASE.priceWei }] };
      }
      if (path === '/schedules/mints') return { jobId: 'job-9' };
      throw new Error(`unexpected ${path}`);
    };
    const UPCOMING_MERKLE = { ...ALLOWLIST_PHASE, startMs: NOW + 3_600_000, endMs: NOW + 7_200_000 };
    mount({ phase: UPCOMING_MERKLE, wallets: [WALLET_A] });
    await screen.findByText('OG List');
    open();
    await screen.findByText('1/1');
    fireEvent.click(screen.getByRole('button', { name: 'Set 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

    expect(await screen.findByRole('button', { name: 'Confirm and schedule' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and schedule' }));

    expect(await screen.findByText('1/1 wallet succeeded.')).toBeTruthy();
    const scheduleCall = calls.find((c) => c.path === '/schedules/mints');
    expect(scheduleCall?.body).toMatchObject({ walletId: 'w1', quantity: 1, kind: 'allowlist-opensea', slug: 'lunar-lemurs' });
  });

  it('a signed-mint phase gets the signed scheduling panel, never the "Mint now" button', async () => {
    const SIGNED_PHASE = { ...ALLOWLIST_PHASE, id: 'opensea-2', name: 'GTD', mechanism: 'signed' as const, startMs: NOW + 3_600_000 };
    responder = (path) =>
      path === '/signed-mints/status'
        ? { executionEnabled: true, retryIntervalMs: 250, giveUpMs: 60_000 }
        : { results: [{ walletId: 'w1', address: WALLET_A.address, balanceWei: '0', minted: 0, limit: 1, remaining: 1, eligible: 'eligible', priceWei: SIGNED_PHASE.priceWei }] };
    mount({ phase: SIGNED_PHASE, wallets: [WALLET_A] });
    await screen.findByText('GTD');
    open();
    expect(await screen.findByRole('button', { name: 'Schedule' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mint now' })).toBeNull();
    expect(await screen.findByText('Eligible')).toBeTruthy(); // the eligibility answer, shown as a hint
  });

  it('shows "Schedule" instead of "Mint now" for an upcoming phase', async () => {
    responder = () => ({ results: [] });
    mount({ phase: ALLOWLIST_PHASE, wallets: [] });
    await screen.findByText('OG List');
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    // No wallets: the empty state shows instead of the summary/button, nothing to assert on the button here.
    expect(await screen.findByText(/No active wallets/)).toBeTruthy();
  });

  it('surfaces a preflight error instead of a wallet list: the API reports it as a 4xx (like mint-preview-controller.ts already does), not inside a 200 body, so this must come from the query\'s error, not its data', async () => {
    responder = () => {
      throw new ApiError(400, { error: 'missing_slug', message: 'This collection has no OpenSea listing.' });
    };
    mount({ slug: null });
    await screen.findByText('Public');
    open();
    expect(await screen.findByText('This collection has no OpenSea listing.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('unavailable')).toBeTruthy(); // the collapsed chip, not stuck on "checking…" forever
  });

  it('a signed-mint phase with eligibility checks turned off still schedules: the 400 is a note, not a dead end, and the chip never sticks on "checking…"', async () => {
    responder = (path) => {
      if (path === '/signed-mints/status') return { executionEnabled: true, retryIntervalMs: 250, giveUpMs: 60_000 };
      throw new ApiError(400, { error: 'signed_mint_disabled', message: 'Signed-mint eligibility checks are turned off on this instance.' });
    };
    const SIGNED_PHASE = { ...LIVE_PHASE, id: 'opensea-2', name: 'GTD', kind: 'allowlist' as const, source: 'opensea' as const, mechanism: 'signed' as const, openSeaStageUuid: 'uuid-gtd', startMs: NOW + 3_600_000 };
    mount({ phase: SIGNED_PHASE });
    await screen.findByText('GTD');
    open();
    expect(await screen.findByText(/Signed-mint eligibility checks are turned off on this instance\./)).toBeTruthy();
    expect(screen.queryByText('checking…')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Schedule' })).toBeTruthy();
  });

  it('shows a real eth_call simulation failure alongside an otherwise-eligible wallet', async () => {
    responder = () => ({
      results: [{ walletId: 'w1', address: WALLET_A.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei, simulation: { ok: false, reason: 'insufficient_funds' } }],
    });
    mount({ wallets: [WALLET_A] });
    await screen.findByText('Public');
    open();
    expect(await screen.findByText(/would fail/)).toBeTruthy();
    expect(screen.getByText('Live check: would fail (not enough ETH)')).toBeTruthy();
  });

  it('a live check that could not run, or that the contract refused, says so in plain words', async () => {
    const row = (walletId: string, address: string, reason: string) => ({ walletId, address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei, simulation: { ok: false, reason } });
    responder = () => ({ results: [row('w1', WALLET_A.address, 'reverted'), row('w2', WALLET_B.address, 'rpc_unavailable')] });
    mount({ wallets: [WALLET_A, WALLET_B] });
    await screen.findByText('Public');
    open();
    expect(await screen.findByText('Live check: would fail (the contract refused it)')).toBeTruthy();
    expect(screen.getByText('Live check could not run')).toBeTruthy();
  });

  it('a wallet eligible on a phase that has not opened yet is shown eligible and selectable, not blocked (the point of checking early is pre-selecting before go-live)', async () => {
    const UPCOMING_PHASE = { ...LIVE_PHASE, startMs: NOW + 3_600_000, endMs: NOW + 7_200_000 };
    responder = () => ({
      results: [{ walletId: 'w1', address: WALLET_A.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'eligible', reason: 'stage_not_active', priceWei: LIVE_PHASE.priceWei }],
    });
    mount({ phase: UPCOMING_PHASE, wallets: [WALLET_A] });
    await screen.findByText('Public');
    open();

    expect(await screen.findByText('1/1')).toBeTruthy(); // the eligible chip counts it, not "checking…" and not 0/1
    expect(screen.getByText(/Not live yet/)).toBeTruthy();
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
  });

  it('a wallet on a phase that has already ended reads "Ended", not "Not live yet" (both share the same on-chain stage_not_active reason, only the phase\'s own timing tells them apart)', async () => {
    const ENDED_PHASE = { ...LIVE_PHASE, startMs: NOW - 7_200_000, endMs: NOW - 3_600_000 };
    responder = () => ({
      results: [{ walletId: 'w1', address: WALLET_A.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'eligible', reason: 'stage_not_active', priceWei: LIVE_PHASE.priceWei }],
    });
    mount({ phase: ENDED_PHASE, wallets: [WALLET_A] });
    await screen.findByText('Public');
    open();

    expect(await screen.findByText('1/1')).toBeTruthy();
    expect(screen.getByText(/minted · Ended/)).toBeTruthy();
    expect(screen.queryByText(/Not live yet/)).toBeFalsy();
  });
});

describe('PhaseCard: empty wallets', () => {
  it('shows a message rather than an empty list, and never calls the eligibility route', async () => {
    mount({ wallets: [] });
    await screen.findByText('Public');
    open();
    expect(await screen.findByText(/No active wallets/)).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/eligibility'))).toBe(false);
  });
});

describe('PhaseCard: the ticking countdown never disturbs the rest of the card', () => {
  it('a real tick of the shared clock does not re-fetch eligibility or collapse the open card', async () => {
    let eligibilityCalls = 0;
    responder = (path) => {
      if (path.endsWith('/eligibility')) {
        eligibilityCalls += 1;
        return { results: [{ walletId: 'w1', address: WALLET_A.address, balanceWei: '0', minted: 0, limit: 5, remaining: 5, eligible: 'eligible', priceWei: LIVE_PHASE.priceWei }] };
      }
      throw new Error(`unexpected ${path}`);
    };
    mount({ wallets: [WALLET_A] });
    await screen.findByText('Public');
    open();
    await screen.findByText('1/1'); // eligibility resolved once
    expect(eligibilityCalls).toBe(1);

    // Let a real tick of the shared 1-second clock pass: the countdown tab/summary re-render
    // on their own, nothing else should.
    await new Promise((resolve) => setTimeout(resolve, 1_150));

    expect(eligibilityCalls).toBe(1); // still just the one fetch, the tick did not trigger another
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy(); // still open
    expect(screen.getByRole('checkbox')).toBeTruthy(); // wallet row still rendered, nothing collapsed
  }, 10_000);
});
