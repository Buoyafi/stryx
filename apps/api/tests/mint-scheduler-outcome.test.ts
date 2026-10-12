import { describe, expect, it } from 'vitest';
import { summarizeJob, summarizeOutcome } from '../src/mint-scheduler.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';

const hash = `0x${'a'.repeat(64)}`;

describe('summarizeOutcome (reading a scheduled job\'s stored result)', () => {
  it('has no outcome for a job that has not run (no return value)', () => {
    expect(summarizeOutcome(undefined)).toBeUndefined();
    expect(summarizeOutcome(null)).toBeUndefined();
  });

  it('reads a successful mint as ok with its transaction hash', () => {
    expect(summarizeOutcome({ ok: true, result: { hash, nonce: 4, status: 'pending' } })).toEqual({ ok: true, hash });
  });

  it('reads a failed mint as not ok, with its reason and detail', () => {
    expect(summarizeOutcome({ ok: false, reason: 'simulation_reverted', detail: 'MintQuantityExceedsMaxMintedPerWallet(11, 10)' })).toEqual({
      ok: false,
      reason: 'simulation_reverted',
      detail: 'MintQuantityExceedsMaxMintedPerWallet(11, 10)',
    });
    expect(summarizeOutcome({ ok: false, reason: 'no_active_public_stage', stage: 'preflight' })).toEqual({ ok: false, reason: 'no_active_public_stage' });
  });

  it('does not invent a hash when a success carries none', () => {
    expect(summarizeOutcome({ ok: true, result: {} })).toEqual({ ok: true });
  });

  it('ignores anything that is not a recognisable outcome instead of guessing', () => {
    expect(summarizeOutcome('done')).toBeUndefined();
    expect(summarizeOutcome(42)).toBeUndefined();
    expect(summarizeOutcome({})).toBeUndefined();
    expect(summarizeOutcome({ ok: 'yes' })).toBeUndefined();
  });

  it('never leaks fields beyond the four it exposes', () => {
    const out = summarizeOutcome({ ok: false, reason: 'rpc_unavailable', detail: 'x', stage: 'simulate', secret: 'nope' });
    expect(Object.keys(out ?? {}).sort()).toEqual(['detail', 'ok', 'reason']);
  });
});

describe('summarizeJob (the list\'s view of a BullMQ job) never returns a URL', () => {
  const URL_TEXT = 'The request took too long to respond.\n\nURL: https://rpc.testnet.example/v2/SUPERSECRETKEY\nVersion: viem@2';
  const baseJob = {
    id: '7',
    timestamp: 1000,
    opts: { delay: 500 },
    data: { kind: 'public' as const, request: { ownerId: RESERVED_OPERATOR_USER_ID, walletId: 'w', nftContract: '0xc' as `0x${string}`, chainId: 46630, quantity: 1 } },
    failedReason: '',
    returnvalue: undefined as unknown,
  };

  it('redacts the URL in a thrown job\'s failedReason, keeping the rest of the message', () => {
    const s = summarizeJob({ ...baseJob, failedReason: URL_TEXT }, 'failed');
    expect(s.failedReason).toContain('The request took too long to respond.');
    expect(s.failedReason).toContain('URL: [url]');
    expect(JSON.stringify(s)).not.toContain('SUPERSECRETKEY');
  });

  it('redacts the URL in a finished job\'s outcome detail', () => {
    const s = summarizeJob({ ...baseJob, returnvalue: { ok: false, reason: 'rpc_unavailable', detail: URL_TEXT } }, 'completed');
    expect(s.outcome?.detail).toContain('URL: [url]');
    expect(JSON.stringify(s)).not.toContain('SUPERSECRETKEY');
  });

  it('projects the job fields as before (executeAt is timestamp + delay)', () => {
    expect(summarizeJob(baseJob, 'delayed')).toEqual({ jobId: '7', kind: 'public', state: 'delayed', ownerId: RESERVED_OPERATOR_USER_ID, walletId: 'w', nftContract: '0xc', chainId: 46630, quantity: 1, executeAt: 1500 });
  });

  it('reads executeAt from the job\'s own record when present: BullMQ\'s timestamp + delay goes stale after an edit', () => {
    expect(summarizeJob({ ...baseJob, data: { ...baseJob.data, executeAt: 9_999 } }, 'delayed').executeAt).toBe(9_999);
  });
});
