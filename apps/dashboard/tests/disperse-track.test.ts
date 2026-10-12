import { describe, expect, it, vi } from 'vitest';
import { trackReceipts } from '../src/lib/disperse-track';
import type { RawReceipt } from '../src/lib/receipt-watch';

const H1 = '0x' + '1'.repeat(64);
const H2 = '0x' + '2'.repeat(64);

describe('trackReceipts', () => {
  it('reports each hash as its receipt arrives, and stops when all are in', async () => {
    const rounds: RawReceipt[][] = [[{ hash: H1, status: 'success' }, { hash: H2, status: 'pending' }], [{ hash: H2, status: 'reverted' }]];
    const fetch = vi.fn(async () => rounds.shift() ?? []);
    const seen: [string, string][] = [];
    await trackReceipts(1, [H1, H2], (h, r) => seen.push([h, r.status]), { fetch, sleep: async () => {} });
    expect(seen).toEqual([[H1, 'success'], [H2, 'reverted']]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a hash with no receipt by the deadline is reported unknown, not failed', async () => {
    let t = 0;
    const seen: [string, string][] = [];
    await trackReceipts(1, [H1], (h, r) => seen.push([h, r.status]), { fetch: async () => [{ hash: H1, status: 'pending' }], sleep: async () => { t += 1000; }, now: () => t, intervalMs: 1000, timeoutMs: 3000 });
    expect(seen).toEqual([[H1, 'unknown']]);
  });

  it('a failing lookup counts as "not yet", and the deadline still ends it', async () => {
    let t = 0;
    const seen: string[] = [];
    await trackReceipts(1, [H1], (_h, r) => seen.push(r.status), { fetch: async () => { throw new Error('rpc down'); }, sleep: async () => { t += 1000; }, now: () => t, intervalMs: 1000, timeoutMs: 2000 });
    expect(seen).toEqual(['unknown']);
  });

  it('at the deadline asks once whether the chain still has each hash: gone means dropped, still there means unknown', async () => {
    let t = 0;
    const asked: boolean[] = [];
    const seen: [string, string][] = [];
    const fetch = async (_c: number, hs: string[], opts?: { lookup?: boolean }): Promise<RawReceipt[]> => {
      asked.push(opts?.lookup === true);
      if (!opts?.lookup) return hs.map((hash) => ({ hash, status: 'pending' as const }));
      return [{ hash: H1, status: 'not_found' }, { hash: H2, status: 'pending' }];
    };
    await trackReceipts(1, [H1, H2], (h, r) => seen.push([h, r.status]), { fetch, sleep: async () => { t += 1000; }, now: () => t, intervalMs: 1000, timeoutMs: 2000 });
    expect(seen).toEqual([[H1, 'dropped'], [H2, 'unknown']]);
    expect(asked.filter(Boolean)).toHaveLength(1); // the extra chain read happens once, at the end
    expect(asked[asked.length - 1]).toBe(true);
  });

  it('a receipt that turns up in that last question still counts', async () => {
    let t = 0;
    const seen: string[] = [];
    const fetch = async (_c: number, _hs: string[], opts?: { lookup?: boolean }): Promise<RawReceipt[]> => [{ hash: H1, status: opts?.lookup ? 'success' : 'pending' }];
    await trackReceipts(1, [H1], (_h, r) => seen.push(r.status), { fetch, sleep: async () => { t += 1000; }, now: () => t, intervalMs: 1000, timeoutMs: 2000 });
    expect(seen).toEqual(['success']);
  });

  it('never asks for more than the route allows per call', async () => {
    const hashes = Array.from({ length: 120 }, (_, i) => '0x' + i.toString(16).padStart(64, '0'));
    const sizes: number[] = [];
    await trackReceipts(1, hashes, () => {}, { fetch: async (_c, hs) => { sizes.push(hs.length); return hs.map((hash) => ({ hash, status: 'success' as const })); }, sleep: async () => {} });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(120);
  });
});
