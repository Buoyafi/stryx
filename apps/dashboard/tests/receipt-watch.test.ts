// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createMintFeedStore } from '../src/lib/mint-feed-store';
import { pendingTargets, processRound, runReceiptRound, MAX_UNANSWERED_ROUNDS, RECEIPT_BATCH, UNCONFIRMED_AFTER_MS, type FetchReceipts, type RawReceipt } from '../src/lib/receipt-watch';
import { scheduledRefetchInterval, BUSY_POLL_MS, IDLE_POLL_MS } from '../src/lib/scheduled-mints';
import type { DeviceMint, ScheduledJob } from '../src/lib/mint-ops';

const NOW = 10_000_000;
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const H1 = hashOf(1);
const H2 = hashOf(2);

const store = () => createMintFeedStore(null);
const device = (n: number, over: Partial<DeviceMint> = {}): DeviceMint => ({ id: `d${n}`, at: NOW - 5_000, chainId: 46630, nftContract: '0xc', walletId: 'w', address: '0xa', quantity: 1, hash: hashOf(n), ...over });
const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({ jobId: '1', kind: 'public', state: 'delayed', walletId: 'w', nftContract: '0xc', chainId: 46630, quantity: 1, executeAt: NOW + 3_600_000, ...over });
const raw = (hash: string, status: RawReceipt['status'], extra: Partial<RawReceipt> = {}): RawReceipt => ({ hash, status, ...extra });

describe('pendingTargets', () => {
  it('wants device mints and scheduled jobs that broadcast, and nothing else', () => {
    const targets = pendingTargets({
      device: [device(1), device(2, { hash: undefined, error: 'reverted' })],
      jobs: [
        job({ jobId: 'a', state: 'completed', outcome: { ok: true, hash: H2 }, executeAt: NOW - 1000 }),
        job({ jobId: 'b', state: 'completed', outcome: { ok: false, reason: 'x' } }),
        job({ jobId: 'c', state: 'delayed' }),
        job({ jobId: 'd', state: 'active' }),
      ],
      receipts: {},
      unconfirmed: new Set(),
    });
    expect(targets.map((t) => t.hash)).toEqual([H1, H2]);
  });

  it('skips hashes that already have a final receipt or gave up, and de-duplicates', () => {
    const targets = pendingTargets({
      device: [device(1), device(2), device(3)],
      jobs: [job({ state: 'completed', outcome: { ok: true, hash: H1.toUpperCase().replace('0X', '0x') }, executeAt: NOW })],
      receipts: { [H1]: { status: 'success' } },
      unconfirmed: new Set([H2]),
    });
    expect(targets.map((t) => t.hash)).toEqual([hashOf(3)]);
  });
});

describe('runReceiptRound', () => {
  it('resolves mined transactions with gas, leaves pending ones, and reports what it saw pending', async () => {
    const fetchReceipts: FetchReceipts = async () => [raw(H1, 'success', { gasUsed: '21000', effectiveGasPriceWei: '5' }), raw(H2, 'pending')];
    const r = await runReceiptRound([{ chainId: 1, hash: H1, at: NOW }, { chainId: 1, hash: H2, at: NOW }], fetchReceipts, NOW);
    expect(r.resolved).toEqual({ [H1]: { status: 'success', gasUsed: '21000', effectiveGasPriceWei: '5' } });
    expect(r.sawPending).toEqual([H2]);
    expect(r.unconfirmed).toEqual([]);
  });

  it('marks a hash unconfirmed only once it has been pending past the limit', async () => {
    const fetchReceipts: FetchReceipts = async () => [raw(H1, 'pending')];
    expect((await runReceiptRound([{ chainId: 1, hash: H1, at: NOW - UNCONFIRMED_AFTER_MS }], fetchReceipts, NOW)).unconfirmed).toEqual([]);
    expect((await runReceiptRound([{ chainId: 1, hash: H1, at: NOW - UNCONFIRMED_AFTER_MS - 1 }], fetchReceipts, NOW)).unconfirmed).toEqual([H1]);
  });

  it('treats a per-hash RPC hiccup (unknown) as not yet, not as pending or resolved', async () => {
    const r = await runReceiptRound([{ chainId: 1, hash: H1, at: NOW - UNCONFIRMED_AFTER_MS - 1 }], async () => [raw(H1, 'unknown')], NOW);
    expect(r).toEqual({ resolved: {}, sawPending: [], unconfirmed: [], unanswered: [H1] });
  });

  it('batches per chain and never exceeds the route\'s hash limit', async () => {
    const calls: [number, number][] = [];
    const fetchReceipts: FetchReceipts = async (chainId, hashes) => {
      calls.push([chainId, hashes.length]);
      return [];
    };
    const targets = [
      ...Array.from({ length: RECEIPT_BATCH + 5 }, (_, i) => ({ chainId: 1, hash: hashOf(i + 1), at: NOW })),
      { chainId: 2, hash: hashOf(999), at: NOW },
    ];
    await runReceiptRound(targets, fetchReceipts, NOW);
    expect(calls).toEqual([[1, RECEIPT_BATCH], [1, 5], [2, 1]]);
  });

  it('leaves a batch untouched when its call fails, without throwing, and still does the others', async () => {
    const fetchReceipts: FetchReceipts = async (chainId) => {
      if (chainId === 1) throw new Error('API down');
      return [raw(H2, 'success')];
    };
    const r = await runReceiptRound([{ chainId: 1, hash: H1, at: NOW }, { chainId: 2, hash: H2, at: NOW }], fetchReceipts, NOW);
    expect(Object.keys(r.resolved)).toEqual([H2]);
    expect(r.unanswered).toEqual([H1]);
    expect(r.unconfirmed).toEqual([]);
  });
});

describe('processRound: a hash nobody can answer for', () => {
  const rounds = async (s: ReturnType<typeof store>, n: number, fetchReceipts: FetchReceipts) => {
    let left = 1;
    for (let i = 0; i < n; i++) left = await processRound({ store: s, targets: [{ chainId: 1, hash: H1, at: NOW }], fetchReceipts, charge: () => {}, now: NOW });
    return left;
  };

  it('stops being asked about after enough rounds with no answer, whether the call fails or the node says unknown', async () => {
    for (const fetchReceipts of [async () => [raw(H1, 'unknown')], async () => { throw new Error('API down'); }] as FetchReceipts[]) {
      const s = store();
      expect(await rounds(s, MAX_UNANSWERED_ROUNDS - 1, fetchReceipts)).toBe(1);
      expect(s.getSnapshot().unconfirmed.has(H1)).toBe(false);
      expect(await rounds(s, 1, fetchReceipts)).toBe(0);
      expect(s.getSnapshot().unconfirmed.has(H1)).toBe(true);
    }
  });

  it('a short outage does not use up its chances: one real answer starts the count again', async () => {
    const s = store();
    await rounds(s, MAX_UNANSWERED_ROUNDS - 1, async () => [raw(H1, 'unknown')]);
    await rounds(s, 1, async () => [raw(H1, 'pending')]);
    expect(await rounds(s, MAX_UNANSWERED_ROUNDS - 1, async () => [raw(H1, 'unknown')])).toBe(1);
    expect(s.getSnapshot().unconfirmed.has(H1)).toBe(false);
  });
});

describe('processRound: applying a round and replaying the logo on confirmation', () => {
  it('confirms a just-broadcast mint, records its gas, and replays the logo once', async () => {
    const s = store();
    s.recordMints([device(1)]);
    const charge = vi.fn();
    const remaining = await processRound({ store: s, targets: [{ chainId: 46630, hash: H1, at: NOW - 5000 }], fetchReceipts: async () => [raw(H1, 'success', { gasUsed: '21000' })], charge, now: NOW });
    expect(remaining).toBe(0);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot().receipts[H1]).toMatchObject({ status: 'success', gasUsed: '21000' });
    expect(s.getSnapshot().charged[H1]).toBe(true);
  });

  it('replays it ONCE when several confirm in the same round, not once each', async () => {
    const s = store();
    s.recordMints([device(1), device(2)]);
    const charge = vi.fn();
    await processRound({ store: s, targets: [1, 2].map((n) => ({ chainId: 46630, hash: hashOf(n), at: NOW - 5000 })), fetchReceipts: async () => [raw(H1, 'success'), raw(H2, 'success')], charge, now: NOW });
    expect(charge).toHaveBeenCalledTimes(1);
    expect(Object.keys(s.getSnapshot().charged).sort()).toEqual([H1, H2]);
  });

  it('does not replay it for a revert, a still-pending mint, or a failed lookup', async () => {
    const s = store();
    s.recordMints([device(1), device(2)]);
    const charge = vi.fn();
    await processRound({ store: s, targets: [{ chainId: 46630, hash: H1, at: NOW - 5000 }, { chainId: 46630, hash: H2, at: NOW - 5000 }], fetchReceipts: async () => [raw(H1, 'reverted', { gasUsed: '30000' }), raw(H2, 'pending')], charge, now: NOW });
    expect(charge).not.toHaveBeenCalled();
    expect(s.getSnapshot().receipts[H1]?.status).toBe('reverted');
    expect(s.getSnapshot().seenPending.has(H2)).toBe(true);
    await processRound({ store: s, targets: [{ chainId: 46630, hash: H2, at: NOW - 5000 }], fetchReceipts: async () => { throw new Error('down'); }, charge, now: NOW });
    expect(charge).not.toHaveBeenCalled();
  });

  it('does not replay it for old history loading in (never seen pending, broadcast long ago)', async () => {
    const s = store();
    const charge = vi.fn();
    await processRound({ store: s, targets: [{ chainId: 46630, hash: H1, at: NOW - 3_600_000 }], fetchReceipts: async () => [raw(H1, 'success')], charge, now: NOW });
    expect(charge).not.toHaveBeenCalled();
    expect(s.getSnapshot().receipts[H1]?.status).toBe('success');
  });

  it('does replay it for something first seen pending and confirmed on a later round, however old', async () => {
    const s = store();
    const charge = vi.fn();
    const target = { chainId: 46630, hash: H1, at: NOW - 3_600_000 };
    await processRound({ store: s, targets: [target], fetchReceipts: async () => [raw(H1, 'pending')], charge, now: NOW });
    await processRound({ store: s, targets: [target], fetchReceipts: async () => [raw(H1, 'success')], charge, now: NOW + 3000 });
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it('reports how many are still waiting, counting unconfirmed ones as finished waiting', async () => {
    const s = store();
    const targets = [{ chainId: 46630, hash: H1, at: NOW - 1000 }, { chainId: 46630, hash: H2, at: NOW - UNCONFIRMED_AFTER_MS - 1 }, { chainId: 46630, hash: hashOf(3), at: NOW - 1000 }];
    const remaining = await processRound({ store: s, targets, fetchReceipts: async () => [raw(H1, 'pending'), raw(H2, 'pending'), raw(hashOf(3), 'success')], charge: vi.fn(), now: NOW });
    expect(remaining).toBe(1);
    expect(s.getSnapshot().unconfirmed.has(H2)).toBe(true);
  });

  it('does nothing, and makes no request, when there is nothing to watch', async () => {
    const fetchReceipts = vi.fn();
    expect(await processRound({ store: store(), targets: [], fetchReceipts, charge: vi.fn(), now: NOW })).toBe(0);
    expect(fetchReceipts).not.toHaveBeenCalled();
  });
});

describe('scheduledRefetchInterval', () => {
  it('polls slowly when nothing is about to happen, and quickly when something is', () => {
    expect(scheduledRefetchInterval(undefined, NOW)).toBe(IDLE_POLL_MS);
    expect(scheduledRefetchInterval([], NOW)).toBe(IDLE_POLL_MS);
    expect(scheduledRefetchInterval([job({ executeAt: NOW + 600_000 })], NOW)).toBe(IDLE_POLL_MS);
    expect(scheduledRefetchInterval([job({ executeAt: NOW + 119_000 })], NOW)).toBe(BUSY_POLL_MS);
    expect(scheduledRefetchInterval([job({ executeAt: NOW - 3000 })], NOW)).toBe(BUSY_POLL_MS);
    expect(scheduledRefetchInterval([job({ state: 'active' })], NOW)).toBe(BUSY_POLL_MS);
  });

  it('does not stay in fast mode for finished jobs', () => {
    expect(scheduledRefetchInterval([job({ state: 'completed', outcome: { ok: true, hash: H1 } }), job({ state: 'failed' })], NOW)).toBe(IDLE_POLL_MS);
  });
});
