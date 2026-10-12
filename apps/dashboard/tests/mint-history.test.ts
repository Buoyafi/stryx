import { describe, expect, it } from 'vitest';
import {
  RUN_WINDOW_MS,
  buildHistory,
  countLegs,
  entriesFromRows,
  entryFromSignedJob,
  firstReason,
  isHistoricalSignedJob,
  matchesFilter,
  outcomeOf,
  totalQuantity,
  type HistoryEntry,
} from '../src/lib/mint-history';
import type { FeedRow } from '../src/lib/mint-ops';
import type { SignedMintJob, SignedMintReport } from '../src/lib/signed-mint';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const T = 1_700_000_000_000;

const row = (over: Partial<FeedRow> = {}): FeedRow => ({ id: 'r1', at: T, source: 'device', chainId: 8453, nftContract: A, walletId: 'w1', status: 'confirmed', quantity: 1, ...over });

describe('entriesFromRows', () => {
  it('groups rows for one collection and source recorded close together into one run, newest run first', () => {
    const entries = entriesFromRows([
      row({ id: 'a', at: T }),
      row({ id: 'b', at: T + 2_000, walletId: 'w2' }),
      row({ id: 'c', at: T + RUN_WINDOW_MS + 60_000 }), // a later, separate run
    ]);
    expect(entries.map((e) => e.legs.length)).toEqual([1, 2]);
    expect(entries[1]!.at).toBe(T); // a run's time is its earliest row
  });

  it('keeps different collections, chains and sources apart', () => {
    const entries = entriesFromRows([
      row({ id: 'a' }),
      row({ id: 'b', nftContract: B }),
      row({ id: 'c', chainId: 1 }),
      row({ id: 'd', source: 'scheduled' }),
    ]);
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.kind).sort()).toEqual(['direct', 'direct', 'direct', 'scheduled']);
  });

  it('matches a contract regardless of address case', () => {
    expect(entriesFromRows([row({ id: 'a', nftContract: A.toUpperCase().replace('0X', '0x') }), row({ id: 'b', at: T + 1 })])).toHaveLength(1);
  });
});

describe('outcome and filters', () => {
  const entry = (statuses: Array<'confirmed' | 'failed' | 'pending' | 'unconfirmed'>, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
    id: 'e', kind: 'direct', at: T, chainId: 1, nftContract: A, legs: statuses.map((status, i) => ({ id: String(i), walletId: `w${i}`, status, quantity: 2, ...(status === 'failed' ? { reason: 'Nope' } : {}) })), ...over,
  });

  it('counts legs, pending including unconfirmed', () => {
    expect(countLegs(entry(['confirmed', 'failed', 'pending', 'unconfirmed']).legs)).toEqual({ confirmed: 1, failed: 1, pending: 2 });
    expect(totalQuantity(entry(['confirmed', 'failed']))).toBe(4);
  });

  it('words the pill from the legs', () => {
    expect(outcomeOf(entry(['confirmed']))).toEqual({ cls: 'live', label: 'confirmed' });
    expect(outcomeOf(entry(['confirmed', 'confirmed', 'confirmed']))).toEqual({ cls: 'live', label: '3 of 3 confirmed' });
    expect(outcomeOf(entry(['confirmed', 'failed', 'failed']))).toEqual({ cls: 'pending', label: '1 of 3 confirmed' });
    expect(outcomeOf(entry(['failed']))).toEqual({ cls: 'fail', label: 'failed' });
    expect(outcomeOf(entry(['failed', 'failed']))).toEqual({ cls: 'fail', label: '2 failed' });
    expect(outcomeOf(entry(['pending']))).toEqual({ cls: 'idle', label: 'pending' });
    expect(outcomeOf(entry([], { loading: true }))).toEqual({ cls: 'idle', label: 'loading' });
  });

  it('puts a run with both successes and failures under both filters, and hides a loading run from them', () => {
    const mixed = entry(['confirmed', 'failed']);
    const good = entry(['confirmed']);
    const bad = entry(['failed']);
    const pending = entry(['pending']);
    const loading = entry([], { loading: true });
    expect([mixed, good, bad, pending, loading].map((e) => matchesFilter(e, 'success'))).toEqual([true, true, false, false, false]);
    expect([mixed, good, bad, pending, loading].map((e) => matchesFilter(e, 'failed'))).toEqual([true, false, true, false, false]);
    expect([mixed, good, bad, pending, loading].map((e) => matchesFilter(e, 'all'))).toEqual([true, true, true, true, true]);
  });

  it('reports the first failure reason', () => {
    expect(firstReason(entry(['confirmed', 'failed']))).toBe('Nope');
    expect(firstReason(entry(['confirmed']))).toBeUndefined();
  });
});

describe('signed runs', () => {
  const job = (over: Partial<SignedMintJob> = {}): SignedMintJob => ({
    jobId: 'j1', state: 'completed', ownerId: 'u', chainId: 8453, nftContract: A, slug: 's', stageUuid: 'st', stageLabel: 'GTD', startMs: T, executeAt: T,
    wallets: [], totalQuantity: 0, dryRun: false, simulate: false, rehearsal: false, runStatus: 'completed', ...over,
  });

  it('counts only runs that really ran', () => {
    expect(isHistoricalSignedJob(job())).toBe(true);
    expect(isHistoricalSignedJob(job({ state: 'failed', runStatus: null }))).toBe(true);
    expect(isHistoricalSignedJob(job({ dryRun: true }))).toBe(false);
    expect(isHistoricalSignedJob(job({ state: 'delayed' }))).toBe(false);
    expect(isHistoricalSignedJob(job({ state: 'active' }))).toBe(false);
    for (const runStatus of ['cancelled', 'aborted', 'moved']) expect(isHistoricalSignedJob(job({ runStatus }))).toBe(false);
  });

  it('turns a report into legs with how fast each landed, and plain reasons', () => {
    const attempt = (over: Record<string, unknown>) => ({
      walletId: 'w', walletAddress: A, quantity: 3, status: 'confirmed', reason: null, detail: null, txHash: null, calldataMs: 1, simulatedMs: null, simulateDurationMs: null, signedMs: 2,
      broadcastMs: 1100, confirmedMs: 1900, notActiveCount: 0, rateLimitedCount: 0, ...over,
    });
    const report = {
      run: { jobId: 'j1', status: 'completed', t0: 'x', dryRun: false, clockSkewed: null, clockSummary: null, notes: null },
      attempts: [
        attempt({ walletId: 'w1', txHash: '0x1' }),
        attempt({ walletId: 'w2', status: 'broadcast', confirmedMs: null }),
        attempt({ walletId: 'w3', status: 'failed', reason: 'insufficient_funds', broadcastMs: null, confirmedMs: null }),
        attempt({ walletId: 'w4', status: 'reverted', txHash: '0x4' }),
        attempt({ walletId: 'w5', status: 'skipped', reason: 'not_eligible', broadcastMs: null, confirmedMs: null }),
      ],
    } as unknown as SignedMintReport;
    const e = entryFromSignedJob(job(), report);
    expect(e).toMatchObject({ kind: 'signed', stageLabel: 'GTD', jobId: 'j1', at: T });
    expect(e.legs.map((l) => l.status)).toEqual(['confirmed', 'pending', 'failed', 'failed', 'failed']);
    expect(e.legs[0]).toMatchObject({ landedMs: 1900, hash: '0x1' });
    expect(e.legs[1]).toMatchObject({ landedMs: 1100 }); // sent, not yet confirmed: its send time
    expect(e.legs[2]!.reason).toBe('Not enough funds');
    expect(e.legs[3]!.reason).toBe('Reverted on-chain');
    expect(e.legs[4]!.reason).toBe('Not eligible for this stage');
  });

  it('is loading until the report arrives, and a bare failure if the job itself failed', () => {
    expect(entryFromSignedJob(job())).toMatchObject({ loading: true, legs: [] });
    const failed = entryFromSignedJob(job({ state: 'failed', runStatus: null }));
    expect(failed.loading).toBeUndefined();
    expect(outcomeOf(failed)).toEqual({ cls: 'fail', label: 'failed' });
  });
});

describe('buildHistory', () => {
  it('merges device runs and signed runs, newest first', () => {
    const signed = entryFromSignedJob({ jobId: 'j', state: 'completed', ownerId: 'u', chainId: 1, nftContract: B, slug: 's', stageUuid: 'x', stageLabel: 'FCFS', startMs: T + 500_000, executeAt: T, wallets: [], totalQuantity: 0, dryRun: false, simulate: false, rehearsal: false, runStatus: 'completed' });
    const list = buildHistory({ rows: [row({ id: 'a', at: T }), row({ id: 'b', at: T + 900_000, nftContract: B })], signed: [signed] });
    expect(list.map((e) => e.at)).toEqual([T + 900_000, T + 500_000, T]);
  });
});
