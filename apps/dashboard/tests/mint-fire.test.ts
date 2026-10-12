import { describe, expect, it, vi, beforeEach } from 'vitest';

const calls: { path: string; method: string; body?: unknown }[] = [];
let responder: (path: string, method: string, body: unknown) => unknown = () => {
  throw new Error('unexpected call');
};

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ path, method, body: options.body });
      return responder(path, method, options.body);
    }),
  };
});

import { resolveSelection, totalCostWei, groupByQuantity, fireNow, scheduleAll, type EligibleSelection } from '../src/lib/mint-fire';
import { ApiError } from '../src/lib/api';
import { OUTCOME_UNKNOWN } from '../src/lib/mint-error';
import { checkPhaseEligibility, type WalletEligibilityRow } from '../src/lib/mint-eligibility';
import type { Phase } from '../src/lib/collection-phases';

const PUBLIC_PHASE: Phase = { id: 'public', name: 'Public', kind: 'public', priceWei: '1000000000000000', startMs: 1_700_000_000_000, endMs: 1_800_000_000_000, maxPerWallet: 2, source: 'on-chain', mechanism: null, openSeaStageUuid: null };
const MERKLE_PHASE: Phase = { id: 'opensea-0', name: 'OG', kind: 'allowlist', priceWei: '0', startMs: 1_700_000_000_000, endMs: 1_800_000_000_000, maxPerWallet: 2, source: 'opensea', mechanism: 'merkle', openSeaStageUuid: 'uuid-og' };

const row = (over: Partial<WalletEligibilityRow>): WalletEligibilityRow => ({
  walletId: 'w1',
  address: '0x1111111111111111111111111111111111111a',
  balanceWei: '1000000000000000000',
  minted: 0,
  limit: 5,
  remaining: 5,
  eligible: 'eligible',
  priceWei: '1000000000000000',
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  responder = () => {
    throw new Error('unexpected call');
  };
});

describe('resolveSelection', () => {
  it('resolves a fixed-quantity wallet directly', () => {
    const rows = new Map([['w1', row({ walletId: 'w1' })]]);
    const out = resolveSelection(new Set(['w1']), { w1: 3 }, {}, rows);
    expect(out).toEqual([{ walletId: 'w1', address: row({}).address, priceWei: '1000000000000000', isMax: false, quantity: 3 }]);
  });

  it('resolves an isMax wallet to its own remaining', () => {
    const rows = new Map([['w1', row({ walletId: 'w1', remaining: 4 })]]);
    const out = resolveSelection(new Set(['w1']), {}, { w1: true }, rows);
    expect(out[0]).toMatchObject({ isMax: true, quantity: 4 });
  });

  it('skips a selected wallet with no eligibility row yet (still loading)', () => {
    const out = resolveSelection(new Set(['w1']), { w1: 1 }, {}, new Map());
    expect(out).toEqual([]);
  });

  it('skips a selected wallet that is not eligible, even if quantities/maxFlags say otherwise', () => {
    const rows = new Map([['w1', row({ walletId: 'w1', eligible: 'not_eligible', reason: 'not_on_allowlist' })]]);
    const out = resolveSelection(new Set(['w1']), { w1: 1 }, {}, rows);
    expect(out).toEqual([]);
  });

  it('skips a fixed-quantity wallet configured at 0', () => {
    const rows = new Map([['w1', row({ walletId: 'w1' })]]);
    const out = resolveSelection(new Set(['w1']), { w1: 0 }, {}, rows);
    expect(out).toEqual([]);
  });

  it('skips an isMax wallet whose remaining is unknown (null) or already zero', () => {
    const rows = new Map([
      ['w1', row({ walletId: 'w1', remaining: null })],
      ['w2', row({ walletId: 'w2', remaining: 0 })],
    ]);
    const out = resolveSelection(new Set(['w1', 'w2']), {}, { w1: true, w2: true }, rows);
    expect(out).toEqual([]);
  });
});

describe('totalCostWei', () => {
  it('sums price * quantity across the selection', () => {
    const selection: EligibleSelection[] = [
      { walletId: 'w1', address: '0xa', priceWei: '1000000000000000', isMax: false, quantity: 2 },
      { walletId: 'w2', address: '0xb', priceWei: '1000000000000000', isMax: false, quantity: 1 },
    ];
    expect(totalCostWei(selection)).toBe('3000000000000000');
  });

  it('returns null when no wallet in the selection has a known price', () => {
    const selection: EligibleSelection[] = [{ walletId: 'w1', address: '0xa', priceWei: null, isMax: false, quantity: 2 }];
    expect(totalCostWei(selection)).toBeNull();
  });

  it('returns an empty-total zero for an empty selection', () => {
    expect(totalCostWei([])).toBeNull();
  });
});

describe('groupByQuantity', () => {
  it('groups wallets with the same fixed quantity together, one call per distinct group', () => {
    const selection: EligibleSelection[] = [
      { walletId: 'w1', address: '0xa', priceWei: '0', isMax: false, quantity: 1 },
      { walletId: 'w2', address: '0xb', priceWei: '0', isMax: false, quantity: 1 },
      { walletId: 'w3', address: '0xc', priceWei: '0', isMax: false, quantity: 2 },
    ];
    const groups = groupByQuantity(selection);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.quantity === 1)?.wallets.map((w) => w.walletId)).toEqual(['w1', 'w2']);
    expect(groups.find((g) => g.quantity === 2)?.wallets.map((w) => w.walletId)).toEqual(['w3']);
  });

  it('puts every isMax wallet into one "max" group regardless of their differing resolved quantities', () => {
    const selection: EligibleSelection[] = [
      { walletId: 'w1', address: '0xa', priceWei: '0', isMax: true, quantity: 4 },
      { walletId: 'w2', address: '0xb', priceWei: '0', isMax: true, quantity: 1 },
    ];
    const groups = groupByQuantity(selection);
    expect(groups).toEqual([{ quantity: 'max', wallets: selection }]);
  });
});

describe('fireNow', () => {
  it('fires one /mints/seadrop/batch call per quantity group, for a public phase', async () => {
    responder = (path, method) => {
      if (path === '/mints/seadrop/batch' && method === 'POST') {
        return { ok: true, results: [{ walletId: 'w1', address: '0xa', status: 'sent', quantity: 1, hash: '0xhash1' }] };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const selection: EligibleSelection[] = [{ walletId: 'w1', address: '0xa', priceWei: '0', isMax: false, quantity: 1 }];
    const rows = await fireNow({ nftContract: '0xNFT', chainId: 46630, phase: PUBLIC_PHASE, slug: null }, selection);
    expect(rows).toEqual([{ walletId: 'w1', address: '0xa', status: 'sent', quantity: 1, hash: '0xhash1', detail: undefined }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ stage: 'public', quantity: 1, walletIds: ['w1'] });
  });

  it('sends stage=allowlist, proofSource=opensea and the slug for a Merkle phase', async () => {
    responder = () => ({ ok: true, results: [{ walletId: 'w1', address: '0xa', status: 'sent', quantity: 1, hash: '0xhash1' }] });
    const selection: EligibleSelection[] = [{ walletId: 'w1', address: '0xa', priceWei: '0', isMax: false, quantity: 1 }];
    await fireNow({ nftContract: '0xNFT', chainId: 46630, phase: MERKLE_PHASE, slug: 'kid-story' }, selection);
    expect(calls[0]!.body).toMatchObject({ stage: 'allowlist', proofSource: 'opensea', slug: 'kid-story' });
  });

  it('sends the literal "max" for an isMax group, not a resolved number, so the server resolves it fresh', async () => {
    responder = () => ({ ok: true, results: [{ walletId: 'w1', address: '0xa', status: 'sent', quantity: 3, hash: '0xhash1' }] });
    const selection: EligibleSelection[] = [{ walletId: 'w1', address: '0xa', priceWei: '0', isMax: true, quantity: 3 }];
    await fireNow({ nftContract: '0xNFT', chainId: 46630, phase: PUBLIC_PHASE, slug: null }, selection);
    expect(calls[0]!.body).toMatchObject({ quantity: 'max' });
  });

  it('fires groups sequentially; a request that dies is "unknown", never "failed", and the next group still fires', async () => {
    responder = (_path, _method, body) => {
      const { quantity } = body as { quantity: number };
      if (quantity === 1) throw new Error('network dropped');
      return { ok: true, results: [{ walletId: 'w2', address: '0xb', status: 'sent', quantity: 2, hash: '0xhash2' }] };
    };
    const selection: EligibleSelection[] = [
      { walletId: 'w1', address: '0xa', priceWei: '0', isMax: false, quantity: 1 },
      { walletId: 'w2', address: '0xb', priceWei: '0', isMax: false, quantity: 2 },
    ];
    const rows = await fireNow({ nftContract: '0xNFT', chainId: 46630, phase: PUBLIC_PHASE, slug: null }, selection);
    expect(calls).toHaveLength(2);
    expect(rows.find((r) => r.walletId === 'w1')).toMatchObject({ status: 'unknown', detail: OUTCOME_UNKNOWN });
    expect(rows.find((r) => r.walletId === 'w2')).toMatchObject({ status: 'sent', hash: '0xhash2' });
  });

  it('a refusal the server gave is a plain failure; a crash or a send it could not confirm is not', async () => {
    const selection: EligibleSelection[] = [{ walletId: 'w1', address: '0xa', priceWei: '0', isMax: false, quantity: 1 }];
    const fire = () => fireNow({ nftContract: '0xNFT', chainId: 46630, phase: PUBLIC_PHASE, slug: null }, selection);

    responder = () => { throw new ApiError(413, { error: 'too_many_wallets', message: 'A batch is limited to 25 wallets.' }); };
    expect((await fire())[0]).toMatchObject({ status: 'failed', detail: 'A batch is limited to 25 wallets.' });

    responder = () => { throw new ApiError(500, { error: 'internal_server_error' }); };
    expect((await fire())[0]).toMatchObject({ status: 'unknown' });

    responder = () => ({ ok: false, results: [{ walletId: 'w1', address: '0xa', status: 'unknown', quantity: 1, hash: '0xhash9', error: 'May have been sent. Check Activity before retrying.' }] });
    expect((await fire())[0]).toMatchObject({ status: 'unknown', hash: '0xhash9' });
  });
});

describe('more wallets than one request takes', () => {
  it('a mint of 60 wallets goes out as batches of 25, 25 and 10, and every wallet gets its row', async () => {
    const selection: EligibleSelection[] = Array.from({ length: 60 }, (_, i) => ({ walletId: `w${i}`, address: `0x${i}`, priceWei: '0', isMax: true, quantity: 1 }));
    responder = (_path, _method, body) => ({
      ok: true,
      results: (body as { walletIds: string[] }).walletIds.map((walletId) => ({ walletId, address: '0x', status: 'sent', quantity: 1, hash: `0xhash-${walletId}` })),
    });

    const rows = await fireNow({ nftContract: '0xNFT', chainId: 46630, phase: PUBLIC_PHASE, slug: null }, selection);

    expect(calls.map((c) => (c.body as { walletIds: string[] }).walletIds.length)).toEqual([25, 25, 10]);
    expect(rows).toHaveLength(60);
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect(rows.map((r) => r.walletId)).toEqual(selection.map((s) => s.walletId));
  });

  it('eligibility for 230 wallets is asked 100 at a time and joined into one answer', async () => {
    const walletIds = Array.from({ length: 230 }, (_, i) => `w${i}`);
    responder = (_path, _method, body) => ({ results: (body as { walletIds: string[] }).walletIds.map((walletId) => ({ walletId, eligible: 'eligible' })) });

    const outcome = await checkPhaseEligibility(46630, '0xNFT', { slug: null, walletIds, phase: PUBLIC_PHASE });

    expect(calls.map((c) => (c.body as { walletIds: string[] }).walletIds.length)).toEqual([100, 100, 30]);
    expect(outcome.results.map((r) => r.walletId)).toEqual(walletIds);
  });

  it('a reason the phase cannot be checked at all is returned once, without asking about the rest', async () => {
    responder = () => ({ preflightError: 'missing_slug', detail: 'This phase needs an OpenSea slug.', results: [] });
    const outcome = await checkPhaseEligibility(46630, '0xNFT', { slug: null, walletIds: Array.from({ length: 150 }, (_, i) => `w${i}`), phase: MERKLE_PHASE });
    expect(outcome.preflightError).toBe('missing_slug');
    expect(calls).toHaveLength(1);
  });
});

describe('scheduleAll', () => {
  it('schedules a public phase through /schedules/mints/auto, once per wallet', async () => {
    responder = (path, method) => {
      if (path === '/schedules/mints/auto' && method === 'POST') return { jobId: 'job-1' };
      throw new Error(`unexpected ${method} ${path}`);
    };
    const selection: EligibleSelection[] = [{ walletId: 'w1', address: '0xa', priceWei: '0', isMax: false, quantity: 1 }];
    const rows = await scheduleAll({ nftContract: '0xNFT', chainId: 46630, phase: PUBLIC_PHASE, slug: null }, selection);
    expect(rows).toEqual([{ walletId: 'w1', address: '0xa', status: 'scheduled', quantity: 1, detail: 'Scheduled (job job-1).' }]);
    // The price shown when scheduling travels with the job as the most it may pay per token.
    expect(calls[0]!.body).toEqual({ walletId: 'w1', nftContract: '0xNFT', chainId: 46630, quantity: 1, maxPriceWei: '0' });
  });

  it('a wallet whose price is not known is scheduled without a ceiling rather than a made-up one', async () => {
    responder = () => ({ jobId: 'job-1' });
    await scheduleAll({ nftContract: '0xNFT', chainId: 46630, phase: PUBLIC_PHASE, slug: null }, [{ walletId: 'w1', address: '0xa', priceWei: null, isMax: false, quantity: 1 }]);
    expect(calls[0]!.body).not.toHaveProperty('maxPriceWei');
  });

  it('schedules a Merkle phase through /schedules/mints with a fixed executeAt at the phase start', async () => {
    responder = (path, method) => {
      if (path === '/schedules/mints' && method === 'POST') return { jobId: 'job-2' };
      throw new Error(`unexpected ${method} ${path}`);
    };
    const selection: EligibleSelection[] = [{ walletId: 'w1', address: '0xa', priceWei: '0', isMax: true, quantity: 4 }];
    const rows = await scheduleAll({ nftContract: '0xNFT', chainId: 46630, phase: MERKLE_PHASE, slug: 'kid-story' }, selection);
    expect(rows).toEqual([{ walletId: 'w1', address: '0xa', status: 'scheduled', quantity: 4, detail: 'Scheduled (job job-2).' }]);
    expect(calls[0]!.body).toMatchObject({ walletId: 'w1', quantity: 4, kind: 'allowlist-opensea', slug: 'kid-story', executeAt: new Date(MERKLE_PHASE.startMs!).toISOString() });
  });

  it('one wallet failing to schedule does not stop the rest', async () => {
    responder = (_path, _method, body) => {
      const { walletId } = body as { walletId: string };
      if (walletId === 'w1') throw new Error('rate limited');
      return { jobId: 'job-3' };
    };
    const selection: EligibleSelection[] = [
      { walletId: 'w1', address: '0xa', priceWei: '0', isMax: false, quantity: 1 },
      { walletId: 'w2', address: '0xb', priceWei: '0', isMax: false, quantity: 1 },
    ];
    const rows = await scheduleAll({ nftContract: '0xNFT', chainId: 46630, phase: PUBLIC_PHASE, slug: null }, selection);
    expect(rows.find((r) => r.walletId === 'w1')).toMatchObject({ status: 'failed', detail: 'rate limited' });
    expect(rows.find((r) => r.walletId === 'w2')).toMatchObject({ status: 'scheduled' });
  });
});

describe('priority fee in request bodies', () => {
  it('fireNow and scheduleAll send priorityFeeGwei when set, and omit it when blank', async () => {
    const selection = [{ walletId: 'w1', address: '0xabc', priceWei: '0', isMax: false, quantity: 1 }];
    calls.length = 0;
    responder = () => ({ ok: true, results: [{ walletId: 'w1', address: '0xabc', status: 'sent', quantity: 1 }] });
    await fireNow({ nftContract: '0xNFT', chainId: 1, phase: PUBLIC_PHASE, slug: null, priorityFeeGwei: ' 2.5 ' }, selection);
    expect(calls[0]!.body).toMatchObject({ priorityFeeGwei: '2.5' });

    calls.length = 0;
    await fireNow({ nftContract: '0xNFT', chainId: 1, phase: PUBLIC_PHASE, slug: null, priorityFeeGwei: '' }, selection);
    expect(calls[0]!.body).not.toHaveProperty('priorityFeeGwei');

    calls.length = 0;
    responder = () => ({ jobId: 'j1' });
    await scheduleAll({ nftContract: '0xNFT', chainId: 1, phase: PUBLIC_PHASE, slug: null, priorityFeeGwei: '4' }, selection);
    expect(calls[0]!.body).toMatchObject({ priorityFeeGwei: '4' });
  });
});
