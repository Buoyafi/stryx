import { describe, expect, it } from 'vitest';
import { formatReport, stepStats, toCsv } from '../src/signed-mint-report.js';
import type { SignedMintAttemptRow, SignedMintRunRow } from '../src/signed-mint-repository.js';

const run: SignedMintRunRow = {
  jobId: 'signed-1',
  ownerId: 'o',
  chainId: 4663,
  contract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768',
  slug: 'kid-story',
  stageUuid: 's',
  stageLabel: 'FCFS',
  t0: new Date('2026-09-28T16:00:00.000Z'),
  dryRun: false,
  simulate: true,
  rehearsal: false,
  status: 'finished',
  clockSkewed: true,
  clockSummary: 'server clock vs opensea +1500ms (±520ms)',
  notes: 'fees: maxFeePerGas 20000000 wei',
  warmupAt: null,
  finishedAt: null,
  createdAt: new Date(),
};

const row = (walletId: string, over: Partial<SignedMintAttemptRow>): SignedMintAttemptRow => ({
  jobId: 'signed-1',
  ownerId: 'o',
  walletId,
  walletAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  quantity: 1,
  status: 'confirmed',
  reason: null,
  detail: null,
  txHash: '0xabc',
  nonce: 1,
  blockNumber: '1',
  gasUsed: '100',
  effectiveGasPriceWei: '1',
  valueWei: '0',
  calldataMs: null,
  simulatedMs: null,
  simulateDurationMs: null,
  signedMs: null,
  broadcastMs: null,
  confirmedMs: null,
  notActiveCount: 0,
  rateLimitedCount: 0,
  errorCount: 0,
  requestCount: 0,
  ...over,
});

const attempts = [
  row('w1', { calldataMs: 30, simulatedMs: 60, simulateDurationMs: 25, signedMs: 64, broadcastMs: 90, confirmedMs: 400 }),
  row('w2', { calldataMs: 50, simulatedMs: 90, simulateDurationMs: 35, signedMs: 95, broadcastMs: 120, confirmedMs: 700 }),
  row('w3', { status: 'failed', reason: 'not_eligible', detail: 'not on list', txHash: null }),
];

describe('signed-mint report', () => {
  it('computes per-step stats over the wallets that reached the step', () => {
    expect(stepStats(attempts, 'calldataMs')).toEqual({ n: 2, min: 30, median: 40, max: 50 });
    expect(stepStats(attempts, 'simulateDurationMs')).toEqual({ n: 2, min: 25, median: 30, max: 35 });
    expect(stepStats([], 'confirmedMs')).toBeNull();
  });

  it('formats a readable table with the clock warning, each wallet, and the stats', () => {
    const text = formatReport(run, attempts);
    expect(text).toMatch(/CLOCK SKEWED: server clock vs opensea \+1500ms/);
    expect(text).toMatch(/not_eligible: not on list/);
    expect(text).toMatch(/calldata\s+30 \/ 40 \/ 50 {2}\(n=2\)/);
    expect(text).toMatch(/sim took\s+25 \/ 30 \/ 35/);
    expect(text).toMatch(/bot time\s+60 \/ 65 \/ 70 {2}\(n=2/); // 90-30 and 120-50
  });

  it('exports CSV with a header and one escaped line per wallet', () => {
    const csv = toCsv(run, [row('w1', { detail: 'has, a comma' })]).split('\n');
    expect(csv[0]).toMatch(/^jobId,t0,walletId,walletAddress,quantity,status,calldataMs/);
    expect(csv[0]).toContain('simulateDurationMs,botTimeMs,');
    expect(csv[1]).toContain('"has, a comma"');
  });
});
