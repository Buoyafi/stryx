import { describe, expect, it, vi } from 'vitest';

// query-core treats a missing `window` as the server and then never marks a query stale, so the test
// gives it one.
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = {};
});

import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import {
  balanceKeys,
  describeTrackOutcome,
  invalidateBalances,
  invalidateWalletListBalances,
  refetchStaleChainBalances,
  trackBroadcast,
  type TxStatus,
} from '../src/lib/balance-cache';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** A simulated chain. */
function simulatedChain(initial: Record<string, number>) {
  const balances = { ...initial };
  const reads: Record<string, number> = {};
  const read = (key: string) => {
    reads[key] = (reads[key] ?? 0) + 1;
  };
  return {
    balances,
    reads,
    readWallet: async (id: string) => {
      read(`wallet:${id}`);
      return balances[id] ?? 0;
    },
    readAll: async () => {
      read('chain');
      return { ...balances };
    },
    mine: (changes: Record<string, number>) => {
      for (const [id, delta] of Object.entries(changes)) balances[id] = (balances[id] ?? 0) + delta;
    },
  };
}

/** Keeps a query active (like a mounted component would) and returns its latest data. */
function watch<T>(qc: QueryClient, queryKey: QueryKey, queryFn: () => Promise<T>, extra: { staleTime?: number } = {}) {
  const observer = new QueryObserver<T>(qc, { queryKey, queryFn, ...extra });
  const unsubscribe = observer.subscribe(() => undefined);
  return { data: () => observer.getCurrentResult().data, unsubscribe, observer };
}

describe('balanceKeys', () => {
  it('puts BOTH balance families under one root, so invalidating the root reaches every balance query', async () => {
    // Invalidating ['balances'] must reach the picker's list too.
    const qc = newClient();
    qc.setQueryData(balanceKeys.wallet('w1'), 'old');
    qc.setQueryData(balanceKeys.chain(46630), 'old');

    await qc.invalidateQueries({ queryKey: balanceKeys.all });

    expect(qc.getQueryState(balanceKeys.wallet('w1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(balanceKeys.chain(46630))?.isInvalidated).toBe(true);
  });

  it('a number and a string chain id are the SAME cache entry, not two that drift apart', () => {
    expect(balanceKeys.chain(46630)).toEqual(balanceKeys.chain('46630'));
    const qc = newClient();
    qc.setQueryData(balanceKeys.chain(46630), 'x');
    expect(qc.getQueryData(balanceKeys.chain('46630'))).toBe('x');
  });

  it('per-wallet keys vary with the wallet id, so switching wallets is a different query', () => {
    expect(balanceKeys.wallet('a')).not.toEqual(balanceKeys.wallet('b'));
  });

  it('a chain key never collides with a wallet key, even if a wallet id looked like a chain id', () => {
    expect(balanceKeys.wallet('46630')).not.toEqual(balanceKeys.chain(46630));
  });
});

describe('invalidateBalances: refreshes every AFFECTED wallet, not just the source', () => {
  it('re-reads the source, each recipient and the chain picker list, and leaves an unrelated wallet alone', async () => {
    const chain = simulatedChain({ src: 1, r1: 0, r2: 0, bystander: 5 });
    const qc = newClient();
    const src = watch(qc, balanceKeys.wallet('src'), () => chain.readWallet('src'));
    const r1 = watch(qc, balanceKeys.wallet('r1'), () => chain.readWallet('r1'));
    const r2 = watch(qc, balanceKeys.wallet('r2'), () => chain.readWallet('r2'));
    const bystander = watch(qc, balanceKeys.wallet('bystander'), () => chain.readWallet('bystander'));
    const picker = watch(qc, balanceKeys.chain('46630'), chain.readAll);
    await sleep(10);
    expect(src.data()).toBe(1);

    chain.mine({ src: -0.3, r1: 0.1, r2: 0.2 }); // the chain has changed
    await invalidateBalances(qc, { chainId: 46630, walletIds: ['src', 'r1', 'r2'] });

    expect(src.data()).toBeCloseTo(0.7);
    expect(r1.data()).toBeCloseTo(0.1);
    expect(r2.data()).toBeCloseTo(0.2);
    expect(picker.data()).toMatchObject({ r1: 0.1, r2: 0.2 });
    expect(chain.reads['wallet:bystander']).toBe(1); // still just the initial read
    [src, r1, r2, bystander, picker].forEach((w) => w.unsubscribe());
  });

  it('does not read a wallet twice if it is listed twice (e.g. a wallet that both sends and receives)', async () => {
    const chain = simulatedChain({ a: 1 });
    const qc = newClient();
    const a = watch(qc, balanceKeys.wallet('a'), () => chain.readWallet('a'));
    await sleep(10);

    await invalidateBalances(qc, { chainId: 1, walletIds: ['a', 'a'] });

    expect(chain.reads['wallet:a']).toBe(2); // initial + exactly one refresh
    a.unsubscribe();
  });

  it('marks an INACTIVE (not currently shown) wallet stale so it refetches when next viewed, instead of showing old data', async () => {
    const qc = newClient();
    qc.setQueryData(balanceKeys.wallet('collapsed-row'), 1);

    await invalidateBalances(qc, { chainId: 1, walletIds: ['collapsed-row'] });

    expect(qc.getQueryState(balanceKeys.wallet('collapsed-row'))?.isInvalidated).toBe(true);
  });
});

describe('invalidateWalletListBalances', () => {
  it('refreshes every chain picker list (a new wallet is missing from all of them) but not per-wallet reads', async () => {
    const qc = newClient();
    qc.setQueryData(balanceKeys.chain(1), 'x');
    qc.setQueryData(balanceKeys.chain(8453), 'x');
    qc.setQueryData(balanceKeys.wallet('w'), 'x');

    await invalidateWalletListBalances(qc);

    expect(qc.getQueryState(balanceKeys.chain(1))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(balanceKeys.chain(8453))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(balanceKeys.wallet('w'))?.isInvalidated).toBe(false);
  });
});

describe('refetchStaleChainBalances: refresh the picker when the operator looks, but only if it has gone stale', () => {
  it('does nothing while the list is fresh, and refetches once it has gone stale', async () => {
    const chain = simulatedChain({ a: 1 });
    const qc = newClient();
    const picker = watch(qc, balanceKeys.chain('46630'), chain.readAll, { staleTime: 40 });
    await sleep(10);
    expect(chain.reads['chain']).toBe(1);

    await refetchStaleChainBalances(qc, 46630); // 10ms old, staleTime 40ms -> still fresh
    expect(chain.reads['chain']).toBe(1);

    chain.mine({ a: 4 });
    await sleep(60); // now stale
    await refetchStaleChainBalances(qc, 46630);
    expect(chain.reads['chain']).toBe(2);
    expect(picker.data()).toMatchObject({ a: 5 });
    picker.unsubscribe();
  });

  it('joins a fetch already in flight rather than cancelling and restarting it', async () => {
    let reads = 0;
    const qc = newClient();
    const picker = watch(
      qc,
      balanceKeys.chain(1),
      async () => {
        reads++;
        await sleep(30);
        return reads;
      },
      { staleTime: 0 },
    );
    await sleep(50); // initial read done
    const before = reads;

    await Promise.all([refetchStaleChainBalances(qc, 1), refetchStaleChainBalances(qc, 1)]);

    expect(reads - before).toBe(1); // two triggers (open + select), one read
    picker.unsubscribe();
  });
});

describe('trackBroadcast: refresh when the transaction is MINED, not when it is broadcast', () => {
  it('does not re-read the chain while the transaction is pending; refreshes every affected wallet the moment it is mined', async () => {
    const chain = simulatedChain({ src: 1, r1: 0, r2: 0, bystander: 5 });
    const qc = newClient();
    const src = watch(qc, balanceKeys.wallet('src'), () => chain.readWallet('src'));
    const r1 = watch(qc, balanceKeys.wallet('r1'), () => chain.readWallet('r1'));
    const r2 = watch(qc, balanceKeys.wallet('r2'), () => chain.readWallet('r2'));
    const bystander = watch(qc, balanceKeys.wallet('bystander'), () => chain.readWallet('bystander'));
    const picker = watch(qc, balanceKeys.chain('46630'), chain.readAll);
    await sleep(10);
    const readsBefore = { ...chain.reads };

    const polledHashes: string[] = [];
    // Snapshots, asserted AFTER the run.
    const readsWhilePending: Record<string, number>[] = [];
    let polls = 0;
    const fetchStatus = async (_chainId: string | number, hash: string): Promise<TxStatus> => {
      polledHashes.push(hash);
      polls++;
      if (polls <= 3) {
        readsWhilePending.push({ ...chain.reads });
        return 'pending';
      }
      chain.mine({ src: -0.3, r1: 0.1, r2: 0.2 }); // the block lands
      return 'success';
    };

    const outcome = await trackBroadcast(
      qc,
      { chainId: 46630, hashes: ['0xfirst', '0xsecond'], walletIds: ['src', 'r1', 'r2'] },
      { fetchStatus, intervalMs: 5, timeoutMs: 2_000 },
    );

    expect(outcome).toBe('confirmed');
    expect(polls).toBe(4);
    // While the transaction is pending nothing re-reads the chain: that would cache the old balance as
    // current.
    expect(readsWhilePending).toHaveLength(3);
    for (const snapshot of readsWhilePending) expect(snapshot).toEqual(readsBefore);
    // Only the LAST hash is polled: same-sender transactions are mined in nonce order.
    expect(new Set(polledHashes)).toEqual(new Set(['0xsecond']));
    // And now everything affected shows the POST-transaction state.
    expect(src.data()).toBeCloseTo(0.7);
    expect(r1.data()).toBeCloseTo(0.1);
    expect(r2.data()).toBeCloseTo(0.2);
    expect(picker.data()).toMatchObject({ r1: 0.1, r2: 0.2 });
    expect(chain.reads['wallet:bystander']).toBe(readsBefore['wallet:bystander']);
    [src, r1, r2, bystander, picker].forEach((w) => w.unsubscribe());
  });

  it('a chain id passed as a NUMBER still refreshes a picker cached under the string form (they are one key)', async () => {
    const chain = simulatedChain({ a: 1 });
    const qc = newClient();
    const picker = watch(qc, balanceKeys.chain('46630'), chain.readAll);
    await sleep(10);
    chain.mine({ a: 1 });

    await trackBroadcast(qc, { chainId: 46630, hashes: ['0xh'], walletIds: ['a'] }, { fetchStatus: async () => 'success', intervalMs: 1 });

    expect(picker.data()).toMatchObject({ a: 2 });
    picker.unsubscribe();
  });

  it('counts a REVERTED transaction as landed: the chain changed (gas was spent), so balances refresh', async () => {
    const chain = simulatedChain({ src: 1 });
    const qc = newClient();
    const src = watch(qc, balanceKeys.wallet('src'), () => chain.readWallet('src'));
    await sleep(10);
    chain.mine({ src: -0.01 });

    const outcome = await trackBroadcast(qc, { chainId: 1, hashes: ['0xh'], walletIds: ['src'] }, { fetchStatus: async () => 'reverted', intervalMs: 1 });

    expect(outcome).toBe('reverted');
    expect(src.data()).toBeCloseTo(0.99);
    src.unsubscribe();
  });

  it('treats a failed receipt lookup as "not yet" and keeps waiting, rather than giving up or refreshing early', async () => {
    const chain = simulatedChain({ src: 1 });
    const qc = newClient();
    const src = watch(qc, balanceKeys.wallet('src'), () => chain.readWallet('src'));
    await sleep(10);
    const readsBefore = chain.reads['wallet:src'];
    let calls = 0;

    const outcome = await trackBroadcast(
      qc,
      { chainId: 1, hashes: ['0xh'], walletIds: ['src'] },
      {
        fetchStatus: async () => {
          calls++;
          if (calls <= 2) throw new Error('RPC blip');
          chain.mine({ src: -0.5 });
          return 'success';
        },
        intervalMs: 3,
        timeoutMs: 2_000,
      },
    );

    expect(outcome).toBe('confirmed');
    expect(calls).toBe(3);
    expect(chain.reads['wallet:src']).toBe(readsBefore + 1); // exactly one refresh, after it landed
    expect(src.data()).toBeCloseTo(0.5);
    src.unsubscribe();
  });

  it('never seeing a receipt is reported as "unconfirmed", not silently treated as done, and still refreshes once at the end', async () => {
    const chain = simulatedChain({ src: 1 });
    const qc = newClient();
    const src = watch(qc, balanceKeys.wallet('src'), () => chain.readWallet('src'));
    await sleep(10);
    const readsBefore = chain.reads['wallet:src'];
    const readsWhilePending: number[] = [];
    let polls = 0;

    const outcome = await trackBroadcast(
      qc,
      { chainId: 1, hashes: ['0xh'], walletIds: ['src'] },
      {
        fetchStatus: async () => {
          polls++;
          readsWhilePending.push(chain.reads['wallet:src'] ?? 0);
          return 'pending';
        },
        intervalMs: 5,
        timeoutMs: 40,
      },
    );

    expect(outcome).toBe('unconfirmed');
    expect(polls).toBeGreaterThan(1);
    // no refresh at any point while it was still being waited on
    for (const seen of readsWhilePending) expect(seen).toBe(readsBefore);
    expect(chain.reads['wallet:src']).toBe(readsBefore + 1);
    src.unsubscribe();
  });

  it('with nothing sent (every transfer failed before broadcast) it does no lookups and no refresh', async () => {
    const chain = simulatedChain({ src: 1 });
    const qc = newClient();
    const src = watch(qc, balanceKeys.wallet('src'), () => chain.readWallet('src'));
    await sleep(10);
    let lookups = 0;

    const outcome = await trackBroadcast(
      qc,
      { chainId: 1, hashes: [], walletIds: ['src'] },
      { fetchStatus: async () => (lookups++, 'success') },
    );

    expect(outcome).toBe('nothing_sent');
    expect(lookups).toBe(0);
    expect(chain.reads['wallet:src']).toBe(1);
    src.unsubscribe();
  });

  it('still refreshes after the component that started it is gone: it depends only on the QueryClient, not on a mounted view', async () => {
    const chain = simulatedChain({ src: 1 });
    const qc = newClient();
    const src = watch(qc, balanceKeys.wallet('src'), () => chain.readWallet('src'));
    await sleep(10);

    const pending = trackBroadcast(qc, { chainId: 1, hashes: ['0xh'], walletIds: ['src'] }, {
      fetchStatus: async () => {
        chain.mine({ src: -0.2 });
        return 'success';
      },
      intervalMs: 1,
    });
    // The operator navigates away mid-wait: the view (observer) is torn down…
    src.unsubscribe();
    await pending;

    // …and the next page to show this wallet must not be handed pre-transaction data.
    expect(qc.getQueryState(balanceKeys.wallet('src'))?.isInvalidated).toBe(true);
  });
});

describe('why the wait exists (characterisation): refreshing at broadcast time caches the OLD balance', () => {
  it('an immediate invalidate reads the pre-transaction chain, and nothing corrects it afterwards', async () => {
    const chain = simulatedChain({ src: 1 });
    const qc = newClient();
    const src = watch(qc, balanceKeys.wallet('src'), () => chain.readWallet('src'));
    await sleep(10);

    // API returned at broadcast; the transaction is not mined. Refresh NOW:
    await invalidateBalances(qc, { chainId: 1, walletIds: ['src'] });
    chain.mine({ src: -0.3 }); // block lands a moment later
    await sleep(30);

    expect(src.data()).toBe(1); // stale, and stays stale
    src.unsubscribe();
  });
});

describe('describeTrackOutcome', () => {
  it('says something honest for every state that matters, and nothing when there is nothing to say', () => {
    expect(describeTrackOutcome('confirming')?.text).toMatch(/confirming/i);
    expect(describeTrackOutcome('confirmed')?.text).toMatch(/updated/i);
    expect(describeTrackOutcome('reverted')?.text).toMatch(/reverted/i);
    expect(describeTrackOutcome('unconfirmed')?.text).toMatch(/stale/i);
    expect(describeTrackOutcome('idle')).toBeNull();
    expect(describeTrackOutcome('nothing_sent')).toBeNull();
  });
});
