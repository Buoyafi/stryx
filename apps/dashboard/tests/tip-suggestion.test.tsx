// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

const calls: string[] = [];
let impl: (path: string) => Promise<unknown> = async () => ({});
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string) => {
      calls.push(path);
      return impl(path);
    }),
  };
});

import { pastPhases, phaseLine, roundUpGwei, showGwei, tipChoices, type TipSuggestion } from '../src/lib/tip-suggestion';
import { PriorityFeeField, type TipContext } from '../src/components/mint/PriorityFeeField';

const G = 1_000_000_000n;
const CONTRACT = '0x00000000000000000000000000000000000000aa';
const GTD = { name: 'GTD', startMs: 1_000_000 };

const reading = (over: Partial<TipSuggestion> = {}): TipSuggestion => ({
  chainId: 8453,
  network: { blocks: 20, typicalWei: String(G / 1000n), busyWei: String(G / 100n), topWei: String(G / 10n), nextBaseFeeWei: String(G / 200n) },
  phases: [
    {
      startMs: GTD.startMs,
      status: 'ok',
      firstBlock: { number: '123', secondsAfterStart: 0.4, mints: 12, minWei: String(G), medianWei: String(3n * G), p90Wei: String(6n * G), maxWei: String(8n * G) },
      opening: { mints: 40, minWei: String(G / 10n), medianWei: String(G), p90Wei: String(5n * G), maxWei: String(8n * G), seconds: 30, blocks: 16, sampled: false },
    },
  ],
  fetchedAt: 0,
  ...over,
});

describe('tip suggestion helpers', () => {
  it('rounds up to two significant figures in gwei, never past 9 decimals', () => {
    expect(roundUpGwei(8_800_000_000n)).toBe('8.8');
    expect(roundUpGwei(8_810_000_000n)).toBe('8.9');
    expect(roundUpGwei(12_300_000_000n)).toBe('13');
    expect(roundUpGwei(123_400_000_000n)).toBe('130');
    expect(roundUpGwei(1_234_567n)).toBe('0.0013');
    expect(roundUpGwei(3n)).toBe('0.000000003');
    expect(roundUpGwei(0n)).toBe('0');
  });

  it('shows gwei with three significant figures', () => {
    expect(showGwei(String(G / 1000n))).toBe('0.001');
    expect(showGwei('1234567890')).toBe('1.23');
    expect(showGwei('123456000000')).toBe('123');
    expect(showGwei('0')).toBe('0');
  });

  it('looks back at phases that have opened, most recent first, at most three', () => {
    const phases = [
      { name: 'Public', startMs: 5000 },
      { name: 'A', startMs: 1000 },
      { name: 'B', startMs: 2000 },
      { name: 'C', startMs: 3000 },
      { name: 'D', startMs: 4000 },
      { name: 'No time', startMs: null },
    ];
    expect(pastPhases(phases, 4500).map((p) => p.name)).toEqual(['D', 'C', 'B']);
  });

  it('offers the earlier phase first (beat the top winner, match the middle), then the chain right now', () => {
    const c = tipChoices(reading(), 8453, [GTD]);
    expect(c.map((x) => [x.key, x.gwei])).toEqual([
      ['beat', '8.8'],
      ['match', '3'],
      ['busy', '0.01'],
      ['top', '0.1'],
    ]);
    expect(c[0]?.why).toMatch(/first block of GTD/);
  });

  it("raises every choice to the chain's minimum and drops the duplicates that makes", () => {
    // Polygon: 25 gwei minimum, so the chain-now readings all become 25.
    const c = tipChoices(reading({ chainId: 137 }), 137, [GTD]);
    expect(c.map((x) => x.gwei)).toEqual(['25']);
  });

  it('caps a choice at the field ceiling, and skips zero readings', () => {
    const r = reading({ network: { blocks: 0, typicalWei: '0', busyWei: '0', topWei: '0', nextBaseFeeWei: null } });
    const p = r.phases[0];
    if (p?.status === 'ok') p.firstBlock.maxWei = String(900n * G);
    expect(tipChoices(r, 8453, [GTD]).map((x) => x.gwei)).toEqual(['500', '3']);
  });

  it('describes each phase opening in a sentence', () => {
    expect(phaseLine(reading().phases[0]!, [GTD])).toBe('GTD: 12 mints in the first block, 0.4s after it opened, paying 1 to 8 gwei (middle 3). 40 in its first 30s, the top paying 8 gwei.');
    expect(phaseLine({ startMs: 1, status: 'quiet', seconds: 30, blocks: 3 }, [{ name: 'FCFS', startMs: 1 }])).toMatch(/FCFS: nobody minted in its first 30s/);
    expect(phaseLine({ startMs: 1, status: 'unavailable' }, [])).toMatch(/could not be read/);
  });
});

function Harness({ chainId = 8453, tipContext }: { chainId?: number; tipContext?: TipContext }) {
  const [v, setV] = useState('');
  return (
    <>
      <PriorityFeeField chainId={chainId} symbol="ETH" value={v} onChange={setV} {...(tipContext ? { tipContext } : {})} />
      <output data-testid="value">{v}</output>
    </>
  );
}

describe('PriorityFeeField Suggest', () => {
  beforeEach(() => {
    calls.length = 0;
    impl = async () => reading();
  });
  afterEach(cleanup);

  it('reads nothing until asked, then asks for this drop and its opened phases', async () => {
    render(<Harness tipContext={{ contract: CONTRACT, pastPhases: [GTD] }} />);
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    await screen.findByRole('region', { name: 'Priority fee suggestions' });
    expect(calls).toEqual([`/chains/8453/priority-fee/suggestion?contract=${CONTRACT}&starts=${GTD.startMs}`]);
    expect(screen.getByText(/GTD: 12 mints in the first block/)).toBeTruthy();
  });

  it('fills the field only when a choice is tapped', async () => {
    render(<Harness tipContext={{ contract: CONTRACT, pastPhases: [GTD] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    const beat = await screen.findByRole('button', { name: /Get ahead/ });
    expect(screen.getByTestId('value').textContent).toBe('');
    fireEvent.click(beat);
    expect(screen.getByTestId('value').textContent).toBe('8.8');
    expect(beat.getAttribute('aria-pressed')).toBe('true');
  });

  it('without a drop, asks for the chain only', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    await screen.findByRole('region', { name: 'Priority fee suggestions' });
    expect(calls).toEqual(['/chains/8453/priority-fee/suggestion']);
  });

  it('says when no earlier phase has opened', async () => {
    impl = async () => reading({ phases: [] });
    render(<Harness tipContext={{ contract: CONTRACT, pastPhases: [] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByText(/No earlier phase of this drop has opened yet/)).toBeTruthy();
  });

  it('shows a short error when the chain could not be read, and can be asked again', async () => {
    impl = async () => {
      throw new Error('502');
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByText(/Couldn't read recent tips/)).toBeTruthy();
    impl = async () => reading();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Priority fee suggestions' })).toBeTruthy());
  });

  it('is not there at all on a first-come-first-served chain', () => {
    render(<Harness chainId={42161} />);
    expect(screen.queryByRole('button', { name: 'Suggest' })).toBeNull();
  });
});
