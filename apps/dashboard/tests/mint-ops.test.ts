import { describe, expect, it } from 'vitest';
import {
  buildFeed,
  deviceMintsFromResults,
  scheduledOutcomeRecords,
  cardState,
  failureReason,
  groupJobs,
  isFinalMinute,
  isSuperseded,
  jobState,
  phaseOf,
  shouldCharge,
  stateAppearance,
  REVERTED_ON_CHAIN,
  type DeviceMint,
  type ReceiptMap,
  type ScheduledJob,
} from '../src/lib/mint-ops';

const NOW = 1_000_000;
const H1 = `0x${'1'.repeat(64)}`;
const H2 = `0x${'2'.repeat(64)}`;
const CONTRACT = '0x14144295aC06Ccd3F5DD9677E15687823d78ACF9';

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  jobId: '1',
  kind: 'public',
  state: 'delayed',
  walletId: 'w1',
  nftContract: CONTRACT,
  chainId: 46630,
  quantity: 1,
  executeAt: NOW + 3_600_000,
  ...over,
});
const none: ReceiptMap = {};

describe('phaseOf', () => {
  it('is public only for the public kind; every allow-list kind is allow-list', () => {
    expect(phaseOf('public')).toBe('public');
    for (const k of ['allowlist-stored', 'allowlist-opensea', 'allowlist-direct']) expect(phaseOf(k)).toBe('allowlist');
  });
});

describe('isFinalMinute', () => {
  it('is true in the last 60s before the due time, false before, at and after it', () => {
    expect(isFinalMinute(NOW, NOW + 60_001)).toBe(false);
    expect(isFinalMinute(NOW, NOW + 60_000)).toBe(true);
    expect(isFinalMinute(NOW, NOW + 1)).toBe(true);
    expect(isFinalMinute(NOW, NOW)).toBe(false);
    expect(isFinalMinute(NOW, NOW - 5)).toBe(false);
  });
});

describe('jobState', () => {
  it('a delayed job is scheduled, then armed in its final minute, then minting once due', () => {
    expect(jobState(job({ executeAt: NOW + 61_000 }), NOW, none)).toBe('scheduled');
    expect(jobState(job({ executeAt: NOW + 59_000 }), NOW, none)).toBe('armed');
    expect(jobState(job({ executeAt: NOW }), NOW, none)).toBe('minting');
    expect(jobState(job({ executeAt: NOW - 500 }), NOW, none)).toBe('minting');
  });

  it('active and waiting jobs are minting', () => {
    expect(jobState(job({ state: 'active' }), NOW, none)).toBe('minting');
    expect(jobState(job({ state: 'waiting' }), NOW, none)).toBe('minting');
  });

  it('a thrown (failed) job is failed', () => {
    expect(jobState(job({ state: 'failed', failedReason: 'boom' }), NOW, none)).toBe('failed');
  });

  it('a completed job whose mint did not go through is failed, NOT done', () => {
    expect(jobState(job({ state: 'completed', outcome: { ok: false, reason: 'simulation_reverted' } }), NOW, none)).toBe('failed');
  });

  it('a completed, broadcast job is minting until its receipt says otherwise', () => {
    const j = job({ state: 'completed', outcome: { ok: true, hash: H1 } });
    expect(jobState(j, NOW, none)).toBe('minting');
    expect(jobState(j, NOW, { [H1]: { status: 'success' } })).toBe('confirmed');
    expect(jobState(j, NOW, { [H1]: { status: 'reverted' } })).toBe('failed');
  });

  it('looks receipts up case-insensitively', () => {
    const j = job({ state: 'completed', outcome: { ok: true, hash: H1.toUpperCase().replace('0X', '0x') } });
    expect(jobState(j, NOW, { [H1]: { status: 'success' } })).toBe('confirmed');
  });

  it('never claims a result it cannot see: completed with no outcome, or no hash, is finished', () => {
    expect(jobState(job({ state: 'completed' }), NOW, none)).toBe('finished');
    expect(jobState(job({ state: 'completed', outcome: { ok: true } }), NOW, none)).toBe('finished');
  });
});

describe('failureReason', () => {
  it('uses the thrown job\'s own reason', () => {
    expect(failureReason(job({ state: 'failed', failedReason: 'The request took too long' }), none)).toBe('The request took too long');
  });

  it('turns an outcome reason into a sentence and appends the detail the backend gave', () => {
    expect(failureReason(job({ state: 'completed', outcome: { ok: false, reason: 'no_active_public_stage' } }), none)).toBe('No active public stage');
    expect(failureReason(job({ state: 'completed', outcome: { ok: false, reason: 'simulation_reverted', detail: 'PayerNotAllowed' } }), none)).toBe('Simulation reverted: PayerNotAllowed');
  });

  it('never lets an RPC URL through in a failure reason, since it can carry an API key', () => {
    const j = job({ state: 'failed', failedReason: 'HTTP request failed.\n\nURL: https://rpc.testnet.example/v1/KEY123\nDetails: fetch failed' });
    expect(failureReason(j, none)).not.toContain('KEY123');
    expect(failureReason(j, none)).toContain('HTTP request failed.');
    const o = job({ state: 'completed', outcome: { ok: false, reason: 'rpc_unavailable', detail: 'could not reach https://rpc.example/k=1' } });
    expect(failureReason(o, none)).toBe('Rpc unavailable: could not reach [url]');
  });

  it('says an on-chain revert has no reason available, since the receipt carries none', () => {
    const j = job({ state: 'completed', outcome: { ok: true, hash: H1 } });
    expect(failureReason(j, { [H1]: { status: 'reverted' } })).toBe(REVERTED_ON_CHAIN);
  });

  it('is undefined for a job that did not fail', () => {
    expect(failureReason(job(), none)).toBeUndefined();
    expect(failureReason(job({ state: 'completed', outcome: { ok: true, hash: H1 } }), { [H1]: { status: 'success' } })).toBeUndefined();
  });
});

describe('isSuperseded', () => {
  it('flags an auto-scheduled job that fired early and handed over to a new job', () => {
    const j = job({ state: 'completed', outcome: { ok: false, reason: 'no_active_public_stage' }, autoRescheduleRemaining: 2 });
    expect(isSuperseded(j)).toBe(true);
  });

  it('does not hide a real no-stage failure with no reschedules left, or any other failure', () => {
    expect(isSuperseded(job({ state: 'completed', outcome: { ok: false, reason: 'no_active_public_stage' }, autoRescheduleRemaining: 0 }))).toBe(false);
    expect(isSuperseded(job({ state: 'completed', outcome: { ok: false, reason: 'no_active_public_stage' } }))).toBe(false);
    expect(isSuperseded(job({ state: 'completed', outcome: { ok: false, reason: 'simulation_reverted' }, autoRescheduleRemaining: 2 }))).toBe(false);
  });
});

describe('cardState', () => {
  const counts = (over: Partial<Record<string, number>>) => ({ scheduled: 0, armed: 0, minting: 0, confirmed: 0, failed: 0, finished: 0, ...over });

  it('lets in-flight and upcoming work win over anything finished', () => {
    expect(cardState(counts({ minting: 1, confirmed: 2 }))).toBe('minting');
    expect(cardState(counts({ armed: 1, failed: 1 }))).toBe('armed');
    expect(cardState(counts({ scheduled: 3 }))).toBe('scheduled');
  });

  it('is confirmed only when everything confirmed, and failed if any finished wallet failed', () => {
    expect(cardState(counts({ confirmed: 3 }))).toBe('confirmed');
    expect(cardState(counts({ confirmed: 2, failed: 1 }))).toBe('failed');
    expect(cardState(counts({ finished: 1, confirmed: 1 }))).toBe('finished');
  });
});

describe('groupJobs', () => {
  it('makes one card per batch: same chain, contract and phase, due within a few seconds', () => {
    const jobs = [job({ jobId: '3', walletId: 'c', executeAt: NOW + 5_000_000 + 40 }), job({ jobId: '1', walletId: 'a', executeAt: NOW + 5_000_000 }), job({ jobId: '2', walletId: 'b', executeAt: NOW + 5_000_000 + 12 })];
    const cards = groupJobs(jobs, NOW, none);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.walletIds.sort()).toEqual(['a', 'b', 'c']);
    expect(cards[0]!.id).toBe('1');
  });

  it('keeps a batch together even when its jobs straddle a second boundary', () => {
    const jobs = [job({ jobId: '1', executeAt: NOW + 5_000_999 }), job({ jobId: '2', walletId: 'b', executeAt: NOW + 5_001_003 })];
    expect(groupJobs(jobs, NOW, none)).toHaveLength(1);
  });

  it('separates different contracts, chains, phases and times', () => {
    const t = NOW + 5_000_000;
    const cards = groupJobs(
      [
        job({ jobId: '1', executeAt: t }),
        job({ jobId: '2', executeAt: t, nftContract: '0x' + '9'.repeat(40) }),
        job({ jobId: '3', executeAt: t, chainId: 4663 }),
        job({ jobId: '4', executeAt: t, kind: 'allowlist-stored' }),
        job({ jobId: '5', executeAt: t + 60_000 }),
      ],
      NOW,
      none,
    );
    expect(cards).toHaveLength(5);
  });

  it('treats a contract address the same whatever its letter case', () => {
    const t = NOW + 5_000_000;
    expect(groupJobs([job({ jobId: '1', executeAt: t }), job({ jobId: '2', executeAt: t, nftContract: CONTRACT.toLowerCase() })], NOW, none)).toHaveLength(1);
  });

  it('leaves out a superseded job', () => {
    const cards = groupJobs(
      [job({ jobId: '1', state: 'completed', outcome: { ok: false, reason: 'no_active_public_stage' }, autoRescheduleRemaining: 2, executeAt: NOW - 1000 }), job({ jobId: '2', executeAt: NOW + 900_000 })],
      NOW,
      none,
    );
    expect(cards.map((c) => c.id)).toEqual(['2']);
  });

  it('counts each wallet\'s state and takes the first failure reason', () => {
    const t = NOW - 60_000;
    const cards = groupJobs(
      [
        job({ jobId: '1', walletId: 'a', state: 'completed', executeAt: t, outcome: { ok: true, hash: H1 } }),
        job({ jobId: '2', walletId: 'b', state: 'completed', executeAt: t, outcome: { ok: false, reason: 'insufficient_funds' } }),
      ],
      NOW,
      { [H1]: { status: 'success' } },
    );
    expect(cards[0]!.counts).toMatchObject({ confirmed: 1, failed: 1 });
    expect(cards[0]!.state).toBe('failed');
    expect(cards[0]!.failure).toBe('Insufficient funds');
    expect(cards[0]!.done).toBe(true);
  });

  it('can be cancelled only while nothing in it has started', () => {
    expect(groupJobs([job({ executeAt: NOW + 600_000 })], NOW, none)[0]!.cancellable).toBe(true);
    expect(groupJobs([job({ executeAt: NOW - 1 })], NOW, none)[0]!.cancellable).toBe(false);
    expect(groupJobs([job({ state: 'active', executeAt: NOW + 600_000 })], NOW, none)[0]!.cancellable).toBe(false);
    expect(groupJobs([job({ state: 'completed', outcome: { ok: false, reason: 'x' }, executeAt: NOW - 5000 })], NOW, none)[0]!.cancellable).toBe(false);
  });

  it('lists upcoming cards soonest first, then finished cards newest first', () => {
    const cards = groupJobs(
      [
        job({ jobId: '1', nftContract: '0x' + '1'.repeat(40), executeAt: NOW + 900_000 }),
        job({ jobId: '2', nftContract: '0x' + '2'.repeat(40), executeAt: NOW + 300_000 }),
        job({ jobId: '3', nftContract: '0x' + '3'.repeat(40), state: 'failed', executeAt: NOW - 900_000 }),
        job({ jobId: '4', nftContract: '0x' + '4'.repeat(40), state: 'failed', executeAt: NOW - 100_000 }),
      ],
      NOW,
      none,
    );
    expect(cards.map((c) => c.id)).toEqual(['2', '1', '4', '3']);
  });
});

describe('stateAppearance: the agreed mapping, every state with its own label', () => {
  it('maps confirmed to live, failed to fail, in-flight to pending and waiting to idle', () => {
    expect(stateAppearance('confirmed')).toEqual({ cls: 'live', label: 'confirmed' });
    expect(stateAppearance('failed')).toEqual({ cls: 'fail', label: 'failed' });
    expect(stateAppearance('minting').cls).toBe('pending');
    expect(stateAppearance('armed').cls).toBe('pending');
    expect(stateAppearance('scheduled').cls).toBe('idle');
    expect(stateAppearance('finished').cls).toBe('idle');
  });

  it('gives armed and minting different labels, since they share the pending glyph', () => {
    expect(stateAppearance('armed').label).not.toBe(stateAppearance('minting').label);
  });
});

describe('buildFeed', () => {
  const dev = (over: Partial<DeviceMint> = {}): DeviceMint => ({ id: 'd1', at: 1000, chainId: 46630, nftContract: CONTRACT, walletId: 'w1', address: '0xabc', quantity: 1, hash: H1, ...over });
  const build = (device: DeviceMint[], jobs: ScheduledJob[] = [], receipts: ReceiptMap = none, unconfirmed: ReadonlySet<string> = new Set()) =>
    buildFeed({ device, jobs, receipts, unconfirmed, addressOf: (id) => (id === 'w1' ? '0xwallet1' : undefined) });

  it('shows a broadcast device mint as pending, then confirmed with gas used once its receipt lands', () => {
    expect(build([dev()])[0]).toMatchObject({ status: 'pending', hash: H1, source: 'device' });
    const done = build([dev()], [], { [H1]: { status: 'success', gasUsed: '21000' } })[0]!;
    expect(done).toMatchObject({ status: 'confirmed', gasUsed: '21000' });
  });

  it('shows an on-chain revert as failed with the honest "reason not available" text', () => {
    expect(build([dev()], [], { [H1]: { status: 'reverted', gasUsed: '30000' } })[0]).toMatchObject({ status: 'failed', reason: REVERTED_ON_CHAIN, gasUsed: '30000' });
  });

  it('shows a mint that failed before broadcast as failed with the backend\'s reason and no hash', () => {
    const row = build([dev({ id: 'f1', hash: undefined, error: 'PayerNotAllowed()' })])[0]!;
    expect(row).toMatchObject({ status: 'failed', reason: 'PayerNotAllowed()' });
    expect(row.hash).toBeUndefined();
  });

  it('marks a hash that never got a receipt as unconfirmed rather than pending forever', () => {
    expect(build([dev()], [], none, new Set([H1]))[0]!.status).toBe('unconfirmed');
  });

  it('includes scheduled jobs that have run: broadcast ones by hash, failed ones with their reason', () => {
    const rows = build(
      [],
      [
        job({ jobId: '1', state: 'completed', executeAt: 5000, outcome: { ok: true, hash: H2 } }),
        job({ jobId: '2', state: 'completed', executeAt: 4000, walletId: 'w9', outcome: { ok: false, reason: 'insufficient_funds' } }),
        job({ jobId: '3', state: 'failed', executeAt: 3000, failedReason: 'The request took too long' }),
        job({ jobId: '4', state: 'delayed', executeAt: NOW + 9999 }),
      ],
    );
    expect(rows.map((r) => r.id)).toEqual([`tx:${H2}`, 'job:2@4000', 'job:3@3000']);
    expect(rows[0]).toMatchObject({ source: 'scheduled', status: 'pending', address: '0xwallet1' });
    expect(rows[1]).toMatchObject({ status: 'failed', reason: 'Insufficient funds' });
    expect(rows[2]).toMatchObject({ status: 'failed', reason: 'The request took too long' });
  });

  it('never lists a not-yet-run job, and never lists a superseded one', () => {
    const rows = build([], [job({ state: 'delayed' }), job({ jobId: '2', state: 'completed', outcome: { ok: false, reason: 'no_active_public_stage' }, autoRescheduleRemaining: 1 })]);
    expect(rows).toEqual([]);
  });

  it('lists one row per hash even if the same transaction is in both sources', () => {
    const rows = build([dev({ at: 9000 })], [job({ state: 'completed', executeAt: 8000, outcome: { ok: true, hash: H1.toUpperCase().replace('0X', '0x') } })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('device');
  });

  it('orders newest first by broadcast time, and a status change never moves a row', () => {
    const device = [dev({ id: 'a', at: 1000, hash: H1 }), dev({ id: 'b', at: 2000, hash: H2 })];
    const before = build(device).map((r) => r.id);
    const after = build(device, [], { [H1]: { status: 'success' }, [H2]: { status: 'reverted' } }).map((r) => r.id);
    expect(before).toEqual([`tx:${H2}`, `tx:${H1}`]);
    expect(after).toEqual(before);
  });
});

describe('shouldCharge (replay the logo on a confirmation)', () => {
  const base = { hash: H1, seenPending: new Set<string>(), eventAt: NOW - 10_000, now: NOW, charged: {} as Record<string, true> };

  it('charges a confirmation of something the session watched pending', () => {
    expect(shouldCharge({ ...base, seenPending: new Set([H1]), eventAt: NOW - 3_600_000 })).toBe(true);
  });

  it('charges a fast confirmation of something broadcast moments ago, even if never seen pending', () => {
    expect(shouldCharge(base)).toBe(true);
  });

  it('does not charge for old history that is merely loading in', () => {
    expect(shouldCharge({ ...base, eventAt: NOW - 3_600_000 })).toBe(false);
  });

  it('charges each hash once', () => {
    expect(shouldCharge({ ...base, charged: { [H1]: true } })).toBe(false);
  });
});

describe('deviceMintsFromResults', () => {
  const ctx = { chainId: 46630, nftContract: CONTRACT, now: 5000 };
  const row = (over: Record<string, unknown>) => ({ walletId: 'w1', address: '0xa', quantity: 1, status: 'sent' as const, ...over });

  it('remembers every broadcast mint (by hash) and every pre-broadcast failure (with its reason)', () => {
    const out = deviceMintsFromResults([row({ hash: H1 }), row({ walletId: 'w2', status: 'failed', error: 'PayerNotAllowed()' })], ctx);
    expect(out).toEqual([
      { id: `tx:${H1}`, at: 5000, chainId: 46630, nftContract: CONTRACT, walletId: 'w1', address: '0xa', quantity: 1, hash: H1 },
      { id: 'fail:5000:w2', at: 5000, chainId: 46630, nftContract: CONTRACT, walletId: 'w2', address: '0xa', quantity: 1, error: 'PayerNotAllowed()' },
    ]);
  });

  it('leaves out skipped wallets (nothing was attempted) and a "sent" row that has no hash', () => {
    expect(deviceMintsFromResults([row({ status: 'skipped' }), row({ hash: undefined })], ctx)).toEqual([]);
  });

  it('gives a failed row without a reason a plain one', () => {
    expect(deviceMintsFromResults([row({ status: 'failed' })], ctx)[0]!.error).toBe('Mint failed');
  });
});

describe('scheduledOutcomeRecords (what the device keeps of finished scheduled jobs)', () => {
  it('keeps a broadcast job by hash and a failed one by a job id that includes its due time', () => {
    const recs = scheduledOutcomeRecords([
      job({ jobId: '1', state: 'completed', executeAt: 5000, outcome: { ok: true, hash: H1 } }),
      job({ jobId: '2', state: 'completed', executeAt: 6000, outcome: { ok: false, reason: 'insufficient_funds' } }),
      job({ jobId: '3', state: 'failed', executeAt: 7000, failedReason: 'The request took too long' }),
    ]);
    expect(recs.map((r) => r.id)).toEqual([`tx:${H1}`, 'job:2@6000', 'job:3@7000']);
    expect(recs.every((r) => r.source === 'scheduled')).toBe(true);
    expect(recs[0]).toMatchObject({ hash: H1, at: 5000 });
    expect(recs[1]!.error).toBe('Insufficient funds');
  });

  it('never keeps a job that has not run, or a superseded one', () => {
    expect(scheduledOutcomeRecords([job({ state: 'delayed' }), job({ jobId: '2', state: 'active' }), job({ jobId: '3', state: 'completed', outcome: { ok: false, reason: 'no_active_public_stage' }, autoRescheduleRemaining: 1 })])).toEqual([]);
  });

  it('stores a short, URL-free reason, not the whole chain-client error (it would fill local storage)', () => {
    const [rec] = scheduledOutcomeRecords([job({ state: 'failed', failedReason: `HTTP request failed.\n\nURL: https://rpc.example/KEY\nRequest body: ${'x'.repeat(5000)}` })]);
    expect(rec!.error).toBe('HTTP request failed.');
    expect(JSON.stringify(rec)).not.toContain('rpc.example');
  });

  it('gives a scheduled record no address of its own, and the feed fills it in from the wallet list', () => {
    const [rec] = scheduledOutcomeRecords([job({ state: 'completed', executeAt: 5000, outcome: { ok: true, hash: H1 } })]);
    expect(rec!.address).toBe('');
    const rows = buildFeed({ device: [rec!], jobs: [], receipts: {}, unconfirmed: new Set(), addressOf: (id) => (id === 'w1' ? '0xwallet1' : undefined) });
    expect(rows[0]).toMatchObject({ source: 'scheduled', address: '0xwallet1' });
  });
});
