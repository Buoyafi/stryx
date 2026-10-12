import { describe, expect, it } from 'vitest';
import { chainStatusRows, lastBalanceRead, type CacheEntry } from '../src/lib/chain-health';

const walletEntry = (updatedAt: number, balances: { chainId: number; error?: string }[]): CacheEntry => ({
  key: ['balances', 'wallet', 'w1'],
  data: { balances },
  updatedAt,
});
const chainEntry = (updatedAt: number, chainId: number, wallets: { error?: string }[]): CacheEntry => ({
  key: ['balances', 'chain', String(chainId)],
  data: { chainId, balances: wallets },
  updatedAt,
});

describe('lastBalanceRead', () => {
  it('is undefined when nothing in the cache has read that chain', () => {
    expect(lastBalanceRead(46630, [])).toBeUndefined();
    expect(lastBalanceRead(46630, [walletEntry(1, [{ chainId: 1 }])])).toBeUndefined();
  });

  it('reads a per-wallet entry: ok, or failed if that chain\'s read carried an error', () => {
    expect(lastBalanceRead(46630, [walletEntry(1, [{ chainId: 46630 }, { chainId: 1, error: 'boom' }])])).toBe('ok');
    expect(lastBalanceRead(46630, [walletEntry(1, [{ chainId: 46630, error: 'timeout' }])])).toBe('failed');
  });

  it('reads a per-chain entry, and only the one for that chain', () => {
    expect(lastBalanceRead(46630, [chainEntry(1, 46630, [{}, {}])])).toBe('ok');
    expect(lastBalanceRead(46630, [chainEntry(1, 46630, [{}, { error: 'rpc down' }])])).toBe('failed');
    expect(lastBalanceRead(46630, [chainEntry(1, 1, [{ error: 'rpc down' }])])).toBeUndefined();
  });

  it('matches a chain id whether the key holds a number or a string', () => {
    expect(lastBalanceRead(46630, [{ key: ['balances', 'chain', 46630], data: { balances: [{}] }, updatedAt: 1 }])).toBe('ok');
  });

  it('takes the most recently updated read when several cover the chain', () => {
    const older = walletEntry(100, [{ chainId: 46630, error: 'timeout' }]);
    const newer = chainEntry(200, 46630, [{}]);
    expect(lastBalanceRead(46630, [older, newer])).toBe('ok');
    expect(lastBalanceRead(46630, [newer, older])).toBe('ok');
  });

  it('ignores an empty or malformed entry', () => {
    expect(lastBalanceRead(46630, [{ key: ['balances', 'chain', '46630'], data: { balances: [] }, updatedAt: 1 }])).toBeUndefined();
    expect(lastBalanceRead(46630, [{ key: ['balances', 'chain', '46630'], data: undefined, updatedAt: 1 }])).toBeUndefined();
  });
});

describe('chainStatusRows', () => {
  it('adds nothing when nothing is known yet (no guessing)', () => {
    expect(chainStatusRows(46630, { configuredChainIds: undefined, apiOk: undefined, balanceRead: undefined })).toEqual([]);
  });

  it('reports a configured chain, a healthy API and a good balance read, each with an ok tone', () => {
    expect(chainStatusRows(46630, { configuredChainIds: [46630, 1], apiOk: true, balanceRead: 'ok' })).toEqual([
      { label: 'API', value: 'Connected', tone: 'ok' },
      { label: 'RPC', value: 'Configured', tone: 'ok' },
      { label: 'Balance read', value: 'OK', tone: 'ok' },
    ]);
  });

  it('flags an unreachable API and a failed balance read with the fail tone, so a glyph accompanies the colour', () => {
    const rows = chainStatusRows(46630, { configuredChainIds: [46630], apiOk: false, balanceRead: 'failed' });
    expect(rows).toContainEqual({ label: 'API', value: 'Unreachable', tone: 'fail' });
    expect(rows).toContainEqual({ label: 'Balance read', value: 'Failed', tone: 'fail' });
  });

  it('says a chain is not configured here (neutral tone) when the API list omits it', () => {
    expect(chainStatusRows(137, { configuredChainIds: [46630], apiOk: undefined, balanceRead: undefined })).toEqual([
      { label: 'RPC', value: 'Not configured', tone: 'idle' },
    ]);
  });

  it('never produces a gas row: the backend exposes no gas data', () => {
    const rows = chainStatusRows(46630, { configuredChainIds: [46630], apiOk: true, balanceRead: 'ok' });
    expect(rows.some((r) => /gas/i.test(r.label))).toBe(false);
  });
});
