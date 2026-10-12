// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JUST_FINISHED_MAX, JUST_FINISHED_MS, JustFinished, justFinished } from '../src/components/JustFinished';
import type { HistoryEntry, HistoryLeg } from '../src/lib/mint-history';

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return { ...actual, apiRequest: vi.fn(async () => ({ openSea: { collectionName: 'Ursa Genesis Pass' } })) };
});

const NOW = Date.parse('2026-09-30T12:00:00Z');
const A = '0x' + 'a'.repeat(40);
const leg = (over: Partial<HistoryLeg> = {}): HistoryLeg => ({ id: 'l1', walletId: 'w1', status: 'confirmed', quantity: 3, address: '0x' + 'b'.repeat(40), hash: '0x' + 'c'.repeat(64), ...over });
const entry = (id: string, ago: number, legs: HistoryLeg[] = [leg()], over: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, kind: 'signed', at: NOW - ago, chainId: 8453, nftContract: A, stageLabel: 'FCFS', legs, ...over });

afterEach(cleanup);

describe('justFinished', () => {
  it('keeps runs from the last day only, at most three, and never a run still loading or empty', () => {
    const list = [
      entry('a', 60_000),
      entry('b', 3_600_000),
      entry('c', 2 * 3_600_000),
      entry('d', 3 * 3_600_000),
      entry('old', JUST_FINISHED_MS + 60_000),
    ];
    expect(justFinished(list, NOW).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(JUST_FINISHED_MAX).toBe(3);
    expect(justFinished([entry('l', 1000, [], { loading: true }), entry('e', 1000, [])], NOW)).toEqual([]);
  });

  it('skips a run dated in the future', () => {
    expect(justFinished([entry('f', -10 * 60_000)], NOW)).toEqual([]);
  });
});

describe('JustFinished', () => {
  function mount(entries: HistoryEntry[], onProof = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <JustFinished entries={entries} now={NOW} chainNames={new Map([[8453, 'Base']])} onProof={onProof} />
      </QueryClientProvider>,
    );
    return onProof;
  }

  it('shows nothing when nothing finished lately', () => {
    mount([entry('old', 3 * 24 * 3_600_000)]);
    expect(screen.queryByRole('region', { name: 'Just finished' })).toBeNull();
  });

  it('shows a card with the result, the NFTs and how fast it landed, and offers the proof card', async () => {
    const onProof = mount([
      entry('a', 10 * 60_000, [leg({ id: '1', landedMs: 1100 }), leg({ id: '2', walletId: 'w2', landedMs: 1900 })]),
    ]);
    const card = await screen.findByRole('article', { name: /Ursa Genesis Pass, 2 of 2 confirmed/ });
    expect(within(card).getByText('done')).not.toBeNull();
    expect(within(card).getByText('6 NFTs')).not.toBeNull();
    expect(within(card).getByText('1.9s after open')).not.toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Create proof card' }));
    expect(onProof).toHaveBeenCalledTimes(1);
    expect(onProof.mock.calls[0]![0].id).toBe('a');
  });

  it('offers no proof card when nothing confirmed, and says it failed', async () => {
    mount([entry('a', 10 * 60_000, [leg({ status: 'failed', reason: 'Not eligible for this stage', hash: undefined })])]);
    const card = await screen.findByRole('article', { name: /failed/ });
    expect(within(card).getByText('failed', { selector: '.pill' })).not.toBeNull();
    expect(within(card).queryByRole('button', { name: 'Create proof card' })).toBeNull();
  });

  it('labels a mix as partly done, and opens the wallet list on Details', async () => {
    mount([entry('a', 10 * 60_000, [leg({ id: '1', landedMs: 1500 }), leg({ id: '2', walletId: 'w2', status: 'failed', reason: 'Not enough funds', hash: undefined })])]);
    const card = await screen.findByRole('article');
    expect(within(card).getByText('partly done')).not.toBeNull();
    const details = within(card).getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    expect(within(card).getByRole('list', { name: /Wallets for/ })).not.toBeNull();
    expect(within(card).getByText('Not enough funds')).not.toBeNull();
    expect(within(card).getByRole('button', { name: 'Hide details' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('says when it ran, for a mint that is not a signed run', async () => {
    mount([entry('a', 5 * 3_600_000, [leg()], { kind: 'scheduled' })]);
    const card = await screen.findByRole('article');
    expect(within(card).getByText('Ran')).not.toBeNull();
    expect(within(card).getByText('5h ago')).not.toBeNull();
  });
});
