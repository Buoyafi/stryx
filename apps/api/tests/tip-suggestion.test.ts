import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  firstBlockAtOrAfter,
  paidTip,
  summarizeFeeHistory,
  tipStats,
  TipSuggestionService,
  MAX_RECEIPTS,
  OPENING_WINDOW_BLOCKS,
  type BlockStamp,
  type MintTxRef,
  type TipChainReader,
} from '../src/tip-suggestion.service.js';
import { tipSuggestionController } from '../src/tip-suggestion-controller.js';
import { registerResponseRedaction } from '../src/response-redaction.js';

const GWEI = 1_000_000_000n;
const CONTRACT = '0x00000000000000000000000000000000000000aa' as const;

/** A chain whose block n is stamped genesis + n * blockSeconds (or by a custom function). */
function fakeChain(opts: { latest: bigint; genesis?: bigint; blockSeconds?: bigint; stampOf?: (n: bigint) => bigint; baseFee?: bigint | null }) {
  const genesis = opts.genesis ?? 1_700_000_000n;
  const ts = opts.stampOf ?? ((n: bigint) => genesis + n * (opts.blockSeconds ?? 2n));
  const baseFee = opts.baseFee === undefined ? 1n * GWEI : opts.baseFee;
  const stamp = (n: bigint): BlockStamp => ({ number: n, timestamp: ts(n), baseFeePerGas: baseFee });
  /** hash -> { block, tip } */
  const mints = new Map<string, { block: bigint; tip: bigint }>();
  const reads = { block: 0, receipts: 0, logs: 0, feeHistory: 0 };
  let n = 0;
  const reader: TipChainReader = {
    feeHistory: vi.fn(async () => {
      reads.feeHistory++;
      return { reward: [[1n, 2n, 3n]], gasUsedRatio: [0.5], baseFeePerGas: [GWEI, GWEI] };
    }),
    latestBlock: async () => stamp(opts.latest),
    block: async (b) => {
      reads.block++;
      if (b < 0n || b > opts.latest) throw new Error(`no block ${b}`);
      return stamp(b);
    },
    mintTxs: async (_c, from, to) => {
      reads.logs++;
      return [...mints.entries()].filter(([, m]) => m.block >= from && m.block <= to).map(([hash, m]): MintTxRef => ({ hash: hash as `0x${string}`, blockNumber: m.block }));
    },
    effectiveGasPrice: async (hash) => {
      reads.receipts++;
      const m = mints.get(hash)!;
      return (baseFee ?? 0n) + m.tip;
    },
  };
  return {
    reader,
    reads,
    ts,
    mint(block: bigint, tipGwei: number) {
      mints.set(`0x${(++n).toString(16).padStart(64, '0')}`, { block, tip: BigInt(Math.round(tipGwei * 1e9)) });
    },
  };
}

describe('tipStats / summarizeFeeHistory / paidTip', () => {
  it('reports min, median, p90 and max of the tips', () => {
    const s = tipStats([5n, 1n, 3n, 2n, 4n, 6n, 7n, 8n, 9n, 10n]);
    expect(s).toEqual({ mints: 10, minWei: '1', medianWei: '5', p90Wei: '9', maxWei: '10' });
  });

  it('takes the median of each percentile over blocks that had transactions, skipping empty blocks', () => {
    const r = summarizeFeeHistory({
      reward: [
        [1n, 10n, 100n],
        [0n, 0n, 0n],
        [3n, 30n, 300n],
        [2n, 20n, 200n],
      ],
      gasUsedRatio: [0.4, 0, 0.9, 0.2],
      baseFeePerGas: [5n, 5n, 5n, 5n, 7n],
    });
    expect(r).toEqual({ blocks: 3, typicalWei: '2', busyWei: '20', topWei: '200', nextBaseFeeWei: '7' });
  });

  it('reports zeros (not a crash) when every recent block was empty, and no base fee on a chain without one', () => {
    expect(summarizeFeeHistory({ reward: [[0n, 0n, 0n]], gasUsedRatio: [0], baseFeePerGas: [0n, 0n] })).toEqual({ blocks: 0, typicalWei: '0', busyWei: '0', topWei: '0', nextBaseFeeWei: null });
  });

  it('a tip is the effective gas price above the base fee, never negative', () => {
    expect(paidTip(12n, 10n)).toBe(2n);
    expect(paidTip(9n, 10n)).toBe(0n);
    expect(paidTip(12n, null)).toBe(12n);
  });
});

describe('firstBlockAtOrAfter', () => {
  it.each([
    ['2s blocks', 2n],
    ['12s blocks', 12n],
    ['1s blocks', 1n],
  ])('finds the exact first block at or after the time (%s)', async (_n, secs) => {
    const c = fakeChain({ latest: 5_000_000n, blockSeconds: secs });
    const latest = await c.reader.latestBlock();
    for (const target of [4_999_999n, 4_000_000n, 1_234_567n, 10n]) {
      // A time between two blocks lands on the later one; a time on a block lands on that block.
      const t = c.ts(target - 1n) + 1n;
      const found = await firstBlockAtOrAfter(c.reader.block, latest, t);
      expect(found?.number).toBe(target);
      expect((await firstBlockAtOrAfter(c.reader.block, latest, c.ts(target)))?.number).toBe(target);
    }
  });

  it('copes with uneven block times (a chain that sped up)', async () => {
    // 12s blocks up to block 1M, then 2s blocks: the 1000-block average misleads the first guess.
    const stampOf = (n: bigint) => (n <= 1_000_000n ? 1_600_000_000n + n * 12n : 1_600_000_000n + 12_000_000n + (n - 1_000_000n) * 2n);
    const c = fakeChain({ latest: 3_000_000n, stampOf });
    const latest = await c.reader.latestBlock();
    for (const target of [500_000n, 999_999n, 1_000_001n, 2_999_000n]) {
      expect((await firstBlockAtOrAfter(c.reader.block, latest, stampOf(target)))?.number).toBe(target);
    }
  });

  it('stays within a few dozen reads on a 40M-block chain', async () => {
    const c = fakeChain({ latest: 40_000_000n, blockSeconds: 2n });
    const latest = await c.reader.latestBlock();
    c.reads.block = 0;
    expect((await firstBlockAtOrAfter(c.reader.block, latest, c.ts(12_345_678n)))?.number).toBe(12_345_678n);
    expect(c.reads.block).toBeLessThan(64);
  });

  it('is null when the chain has not reached the time, and block 0 when the time is before the chain', async () => {
    const c = fakeChain({ latest: 1000n });
    const latest = await c.reader.latestBlock();
    expect(await firstBlockAtOrAfter(c.reader.block, latest, latest.timestamp + 1n)).toBeNull();
    expect((await firstBlockAtOrAfter(c.reader.block, latest, 0n))?.number).toBe(0n);
  });
});

describe('TipSuggestionService', () => {
  const START_BLOCK = 1_000_000n;
  /** The service clock, well after the phase (so its opening is final). */
  const setup = (opts: { blockSeconds?: bigint; baseFee?: bigint | null } = {}) => {
    const c = fakeChain({ latest: 2_000_000n, ...opts });
    const startMs = Number(c.ts(START_BLOCK)) * 1000 - 500; // half a second before block START_BLOCK
    // An hour after the phase: its opening is over, and it is well inside the 60-day limit.
    const now = startMs + 3_600_000;
    return { c, startMs, svc: new TipSuggestionService(() => c.reader, () => now) };
  };

  it('reports what the first block with mints paid, and the whole opening window', async () => {
    const { c, startMs, svc } = setup();
    c.mint(START_BLOCK, 3);
    c.mint(START_BLOCK, 5);
    c.mint(START_BLOCK, 8);
    c.mint(START_BLOCK + 1n, 1);
    c.mint(START_BLOCK + 5n, 0.5);
    c.mint(START_BLOCK - 1n, 99); // before the start: not part of the opening
    const r = await svc.suggest(8453, CONTRACT, [startMs]);
    expect(r.network).toMatchObject({ typicalWei: '1', busyWei: '2', topWei: '3' });
    const p = r.phases[0]!;
    expect(p.status).toBe('ok');
    if (p.status !== 'ok') return;
    expect(p.firstBlock).toMatchObject({ number: String(START_BLOCK), mints: 3, minWei: String(3n * GWEI), medianWei: String(5n * GWEI), maxWei: String(8n * GWEI), secondsAfterStart: 0.5 });
    expect(p.opening).toMatchObject({ mints: 5, minWei: String(GWEI / 2n), maxWei: String(8n * GWEI), sampled: false });
  });

  it("measures the tip above each block's base fee, and the gas price itself on a chain without one", async () => {
    const { c, startMs, svc } = setup({ baseFee: null });
    c.mint(START_BLOCK, 2);
    const p = (await svc.suggest(56, CONTRACT, [startMs])).phases[0]!;
    expect(p.status === 'ok' && p.firstBlock.maxWei).toBe(String(2n * GWEI));
  });

  it('ends the opening at 30 seconds on a slow chain, and at 30 blocks on a fast one', async () => {
    // 12s blocks: blocks START..START+2 are within 30s, START+3 is not.
    const slow = setup({ blockSeconds: 12n });
    slow.c.mint(START_BLOCK + 2n, 4);
    slow.c.mint(START_BLOCK + 3n, 9);
    const ps = (await slow.svc.suggest(1, CONTRACT, [slow.startMs])).phases[0]!;
    expect(ps.status === 'ok' && [ps.opening.mints, ps.opening.maxWei]).toEqual([1, String(4n * GWEI)]);

    // 1s blocks: the window is cut at 30 blocks before 30s is up.
    const fast = setup({ blockSeconds: 1n });
    fast.c.mint(START_BLOCK + BigInt(OPENING_WINDOW_BLOCKS) - 1n, 4);
    fast.c.mint(START_BLOCK + BigInt(OPENING_WINDOW_BLOCKS), 9);
    const pf = (await fast.svc.suggest(1, CONTRACT, [fast.startMs])).phases[0]!;
    expect(pf.status === 'ok' && [pf.opening.mints, pf.opening.blocks]).toEqual([1, OPENING_WINDOW_BLOCKS]);
  });

  it('reads at most MAX_RECEIPTS receipts, earliest first, so the first block is whole', async () => {
    const { c, startMs, svc } = setup();
    for (let i = 0; i < 40; i++) c.mint(START_BLOCK, 2);
    for (let i = 0; i < 40; i++) c.mint(START_BLOCK + 1n, 1);
    const p = (await svc.suggest(8453, CONTRACT, [startMs])).phases[0]!;
    expect(c.reads.receipts).toBe(MAX_RECEIPTS);
    expect(p.status === 'ok' && [p.firstBlock.mints, p.opening.mints, p.opening.sampled]).toEqual([40, MAX_RECEIPTS, true]);
  });

  it('says "quiet" when nobody minted in the opening', async () => {
    const { startMs, svc } = setup();
    expect((await svc.suggest(8453, CONTRACT, [startMs])).phases[0]).toMatchObject({ status: 'quiet', blocks: 16, seconds: 30 });
  });

  it('skips phases that have not started or are too old, and reads at most three', async () => {
    const { startMs, svc } = setup();
    const now = startMs + 3_600_000;
    const r = await svc.suggest(8453, CONTRACT, [now + 60_000, now - 61 * 24 * 3600 * 1000, startMs, startMs - 1000, startMs - 2000]);
    expect(r.phases.map((p) => p.status)).toEqual(['not_started', 'quiet', 'quiet']);
    const r2 = await svc.suggest(8453, CONTRACT, [now - 61 * 24 * 3600 * 1000]);
    expect(r2.phases[0]?.status).toBe('too_old');
  });

  it('keeps a finished opening: the second ask reads nothing from the chain', async () => {
    const { c, startMs, svc } = setup();
    c.mint(START_BLOCK, 3);
    await svc.suggest(8453, CONTRACT, [startMs]);
    const before = { ...c.reads };
    const again = await svc.suggest(8453, CONTRACT.toUpperCase().replace('0X', '0x') as `0x${string}`, [startMs]);
    expect(again.phases[0]?.status).toBe('ok');
    expect([c.reads.block, c.reads.logs, c.reads.receipts]).toEqual([before.block, before.logs, before.receipts]);
  });

  it('a failing phase read is "unavailable", and the network reading still comes back', async () => {
    const { c, startMs, svc } = setup();
    c.reader.mintTxs = async () => {
      throw new Error('logs refused');
    };
    const r = await svc.suggest(8453, CONTRACT, [startMs]);
    expect(r.network).not.toBeNull();
    expect(r.phases).toEqual([{ startMs, status: 'unavailable' }]);
  });

  it('without a contract, reports only the network', async () => {
    const { svc } = setup();
    const r = await svc.suggest(8453, null, [1]);
    expect(r.phases).toEqual([]);
    expect(r.network).not.toBeNull();
  });
});

describe('GET /chains/:chainId/priority-fee/suggestion', () => {
  function build(reader: TipChainReader | null, configured = [8453, 42161]) {
    const errors: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log: any = { debug() {}, info() {}, warn() {}, error: (m: string) => void errors.push(m) };
    const app = Fastify();
    registerResponseRedaction(app, log);
    void app.register(tipSuggestionController({ service: new TipSuggestionService(() => reader), configuredChainIds: configured, logger: log }));
    return { app, errors };
  }

  it('returns the readings', async () => {
    const c = fakeChain({ latest: 100n });
    const { app } = build(c.reader);
    const res = await app.inject(`/chains/8453/priority-fee/suggestion?contract=${CONTRACT}&starts=1`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chainId: 8453, network: { typicalWei: '1' }, phases: [{ status: 'too_old' }] });
  });

  it('refuses a first-come-first-served chain, an unconfigured chain, and too many phases', async () => {
    const { app } = build(fakeChain({ latest: 100n }).reader);
    expect((await app.inject('/chains/42161/priority-fee/suggestion')).json().error).toBe('tip_not_used');
    expect((await app.inject('/chains/1/priority-fee/suggestion')).json().error).toBe('unsupported_chain');
    expect((await app.inject('/chains/8453/priority-fee/suggestion?starts=1,2,3,4')).json().error).toBe('too_many_phases');
  });

  it('rejects a malformed contract or start list', async () => {
    const { app } = build(fakeChain({ latest: 100n }).reader);
    expect((await app.inject('/chains/8453/priority-fee/suggestion?contract=0x12')).statusCode).toBe(400);
    expect((await app.inject('/chains/8453/priority-fee/suggestion?starts=1,x')).statusCode).toBe(400);
  });

  it('is a 502 with a generic message when the chain gave nothing', async () => {
    const c = fakeChain({ latest: 100n });
    c.reader.feeHistory = async () => {
      throw new Error('https://rpc.example/KEY down');
    };
    const { app } = build(c.reader);
    const res = await app.inject('/chains/8453/priority-fee/suggestion');
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('KEY');
  });
});

describe('ViemTipChainReader', () => {
  it('asks for mint logs by raw topics (ERC-721 Transfer and ERC-1155 from zero), dedupes by transaction and keeps chain order', async () => {
    const { createPublicClient, custom } = await import('viem');
    const { ViemTipChainReader } = await import('../src/tip-suggestion-reader.js');
    const calls: { method: string; params: unknown }[] = [];
    const log = (hash: string, block: number, index: number) => ({ transactionHash: hash, blockNumber: `0x${block.toString(16)}`, transactionIndex: `0x${index.toString(16)}` });
    const client = createPublicClient({
      transport: custom({
        request: async ({ method, params }: { method: string; params: unknown }) => {
          calls.push({ method, params });
          if (method === 'eth_getLogs') {
            const topics = (params as [{ topics: unknown[] }])[0].topics;
            // ERC-721: one tx minting two tokens (two logs), plus a later one; ERC-1155: one in between.
            return Array.isArray(topics[0]) ? [log('0xc', 11, 0)] : [log('0xb', 12, 1), log('0xa', 11, 3), log('0xa', 11, 3)];
          }
          if (method === 'eth_getTransactionReceipt') return { effectiveGasPrice: '0x3b9aca00', status: '0x1', logs: [], blockNumber: '0x1', transactionHash: '0xa', transactionIndex: '0x0', blockHash: '0x0', cumulativeGasUsed: '0x0', gasUsed: '0x0', type: '0x2', from: '0x0000000000000000000000000000000000000001', to: null, contractAddress: null, logsBloom: '0x' };
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    const reader = new ViemTipChainReader(client as never);
    const refs = await reader.mintTxs(CONTRACT, 10n, 12n);
    expect(refs.map((r) => [r.hash, r.blockNumber])).toEqual([
      ['0xc', 11n],
      ['0xa', 11n],
      ['0xb', 12n],
    ]);
    const getLogs = calls.filter((c) => c.method === 'eth_getLogs').map((c) => (c.params as [Record<string, unknown>])[0]);
    expect(getLogs[0]).toEqual({ address: CONTRACT, fromBlock: '0xa', toBlock: '0xc', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(64)}`] });
    expect(getLogs[1]?.topics).toEqual([['0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'], null, `0x${'0'.repeat(64)}`]);
    expect(await reader.effectiveGasPrice('0xa')).toBe(GWEI);
  });
});
