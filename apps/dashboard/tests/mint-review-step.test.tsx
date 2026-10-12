// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiRequestCalls: { path: string; body?: unknown }[] = [];
let apiRequestImpl: (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown> = async () => ({});

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      apiRequestCalls.push({ path, body: options.body });
      return apiRequestImpl(path, options);
    }),
  };
});

import { MintReviewStep } from '../src/components/mint/MintReviewStep';
import type { Phase } from '../src/lib/collection-phases';
import type { EligibleSelection } from '../src/lib/mint-fire';

const CHAIN_ID = 46630;

beforeEach(() => {
  apiRequestCalls.length = 0;
  apiRequestImpl = async () => ({});
});
afterEach(cleanup);

const PUBLIC_PHASE: Phase = { id: 'public', name: 'Public', kind: 'public', priceWei: '1000000000000000', startMs: null, endMs: null, maxPerWallet: 2, source: 'on-chain', mechanism: null, openSeaStageUuid: null };

const SELECTION: EligibleSelection[] = [
  { walletId: 'w1', address: '0x1111111111111111111111111111111111111a', priceWei: '1000000000000000', isMax: false, quantity: 2 },
  { walletId: 'w2', address: '0x2222222222222222222222222222222222222b', priceWei: '1000000000000000', isMax: true, quantity: 3 },
];

function renderStep(overrides: Partial<React.ComponentProps<typeof MintReviewStep>> = {}) {
  const onBack = vi.fn();
  const onConfirm = vi.fn();
  render(<MintReviewStep phase={PUBLIC_PHASE} chainId={CHAIN_ID} symbol="ETH" usdPerToken={null} showUsd={false} selection={SELECTION} live confirming={false} onBack={onBack} onConfirm={onConfirm} {...overrides} />);
  return { onBack, onConfirm };
}

describe('MintReviewStep', () => {
  it('shows the total quantity and cost across every selected wallet', () => {
    renderStep();
    expect(screen.getByText(/5 NFTs/)).toBeTruthy(); // 2 + 3
    expect(screen.getByText(/0\.005 ETH/)).toBeTruthy(); // (2+3) * 0.001 ETH
  });

  it('lists every wallet with its own quantity, marking a max one', () => {
    renderStep();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('3 (max)')).toBeTruthy();
  });

  it('says "Confirm and mint" and the not-sent-yet microcopy when live', () => {
    renderStep({ live: true });
    expect(screen.getByRole('button', { name: 'Confirm and mint' })).toBeTruthy();
    expect(screen.getByText('Nothing is sent until you press this.')).toBeTruthy();
  });

  it('says "Confirm and schedule" and the not-scheduled-yet microcopy when not live', () => {
    renderStep({ live: false });
    expect(screen.getByRole('button', { name: 'Confirm and schedule' })).toBeTruthy();
    expect(screen.getByText('Nothing is scheduled until you press this.')).toBeTruthy();
  });

  it('calls onBack and onConfirm from their own buttons', () => {
    const { onBack, onConfirm } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and mint' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while confirming, and shows a working label', () => {
    renderStep({ confirming: true });
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Working…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Confirm when the selection is empty', () => {
    renderStep({ selection: [] });
    expect((screen.getByRole('button', { name: 'Confirm and mint' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('fires a nonce warm-up for every selected wallet on mount, before Confirm is ever pressed', async () => {
    renderStep();
    await waitFor(() => expect(apiRequestCalls.length).toBe(1));
    expect(apiRequestCalls[0]).toMatchObject({ path: `/chains/${CHAIN_ID}/wallets/warm-nonces`, body: { walletIds: ['w1', 'w2'] } });
  });

  it('does not warm anything, and does not crash, when the selection is empty', async () => {
    renderStep({ selection: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(apiRequestCalls).toHaveLength(0);
  });

  it('a rejected warm-up call never surfaces to the operator: the screen renders normally', async () => {
    apiRequestImpl = async () => {
      throw new Error('simulated warm-nonces failure');
    };
    renderStep();
    await waitFor(() => expect(apiRequestCalls.length).toBe(1));
    expect(screen.getByRole('button', { name: 'Confirm and mint' })).toBeTruthy();
  });

  it('priority fee: no field on a first-come chain (Robinhood testnet)', () => {
    renderStep({ onPriorityFeeChange: vi.fn() });
    expect(screen.queryByLabelText('Priority fee in gwei')).toBeNull();
  });

  it('priority fee on Ethereum: the field shows, a bad value blocks Confirm, a good one does not', () => {
    const onPriorityFeeChange = vi.fn();
    const { onConfirm } = renderStep({ chainId: 1, onPriorityFeeChange, priorityFeeGwei: '9999' });
    expect(screen.getByLabelText('Priority fee in gwei')).toBeTruthy();
    expect(screen.getByText(/almost certainly a typo/)).toBeTruthy();
    fireEvent.click(screen.getByText('Confirm and mint'));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Priority fee in gwei'), { target: { value: '3' } });
    expect(onPriorityFeeChange).toHaveBeenCalledWith('3');
  });

  it('priority fee on Polygon: under the 25 gwei minimum is refused', () => {
    renderStep({ chainId: 137, onPriorityFeeChange: vi.fn(), priorityFeeGwei: '10' });
    expect(screen.getByText(/requires at least 25 gwei/)).toBeTruthy();
  });
});
