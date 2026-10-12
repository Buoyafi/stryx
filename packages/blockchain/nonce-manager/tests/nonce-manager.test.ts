import { describe, expect, it, vi } from 'vitest';
import { NonceManager } from '../src/nonce-manager.js';
import {
  InvalidNonceReleaseError,
  NonceReconciliationError,
} from '../src/errors.js';
import type { ChainNonceReader, NonceScope } from '../src/types.js';
import { InMemoryRedisClient } from './in-memory-redis-client.js';

const scope: NonceScope = {
  chainId: 4663, // Robinhood Chain mainnet
  walletAddress: '0x0000000000000000000000000000000000000000',
};

function makeChainReader(initialPending: number): ChainNonceReader & { pending: number } {
  return {
    pending: initialPending,
    async getPendingNonce() {
      return this.pending;
    },
  };
}

describe('NonceManager', () => {
  it('bootstraps from chain state on first allocation', async () => {
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(7);
    const manager = new NonceManager(redis, chain);

    const first = await manager.getNextNonce(scope);
    expect(first).toBe(7);

    const second = await manager.getNextNonce(scope);
    expect(second).toBe(8);
  });

  it('never allocates the same nonce twice under concurrent callers', async () => {
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(0);
    const manager = new NonceManager(redis, chain);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => manager.getNextNonce(scope)),
    );

    const unique = new Set(results);
    expect(unique.size).toBe(50);
    expect([...unique].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('only initializes from chain once under concurrent cold-start', async () => {
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(3);
    const spy = vi.spyOn(chain, 'getPendingNonce');
    const manager = new NonceManager(redis, chain);

    await Promise.all(Array.from({ length: 10 }, () => manager.getNextNonce(scope)));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reuses a released nonce before incrementing further', async () => {
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(0);
    const manager = new NonceManager(redis, chain);

    const n0 = await manager.getNextNonce(scope); // 0
    const n1 = await manager.getNextNonce(scope); // 1
    expect([n0, n1]).toEqual([0, 1]);

    // Simulate: transaction using n1 aborted before broadcast (e.g. emergency stop).
    await manager.releaseNonce(scope, n1);

    const n2 = await manager.getNextNonce(scope);
    expect(n2).toBe(1); // reused, not 2

    const n3 = await manager.getNextNonce(scope);
    expect(n3).toBe(2); // now advances past the counter
  });

  it('rejects releasing a nonce that was never allocated', async () => {
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(0);
    const manager = new NonceManager(redis, chain);

    await manager.getNextNonce(scope); // allocates 0

    await expect(manager.releaseNonce(scope, 99)).rejects.toThrow(InvalidNonceReleaseError);
  });

  it('treats local-ahead-of-chain as normal steady state (pending mempool txs)', async () => {
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(5);
    const manager = new NonceManager(redis, chain);

    await manager.getNextNonce(scope); // local next -> 6, chain still reports 5 (tx pending)

    const result = await manager.resync(scope);
    expect(result).toEqual({ localNext: 6, chainPending: 5, driftDetected: false });
  });

  it('throws NonceReconciliationError when chain is ahead of local state', async () => {
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(5);
    const manager = new NonceManager(redis, chain);

    await manager.getNextNonce(scope); // local next -> 6

    // Simulate Redis data loss / bypassed manager: chain has moved past local state.
    chain.pending = 10;

    await expect(manager.resync(scope)).rejects.toThrow(NonceReconciliationError);
  });

  it('forceResyncToChain overwrites local state and clears the released pool', async () => {
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(0);
    const manager = new NonceManager(redis, chain);

    const n0 = await manager.getNextNonce(scope);
    await manager.releaseNonce(scope, n0);

    chain.pending = 42;
    const resynced = await manager.forceResyncToChain(scope);
    expect(resynced).toBe(42);

    const next = await manager.getNextNonce(scope);
    expect(next).toBe(42); // released pool was cleared, not reused post-resync
  });

  it('catchUpToChain raises the counter when the chain is ahead and drops released nonces the chain already used', async () => {
    const chain = makeChainReader(0);
    const manager = new NonceManager(new InMemoryRedisClient(), chain);
    const n0 = await manager.getNextNonce(scope);
    await manager.getNextNonce(scope);
    await manager.releaseNonce(scope, n0);

    chain.pending = 5;
    expect(await manager.catchUpToChain(scope)).toBe(5);

    expect(await manager.getNextNonce(scope)).toBe(5);
  });

  it('catchUpToChain never lowers the counter: nonces already handed out stay valid', async () => {
    const chain = makeChainReader(0);
    const manager = new NonceManager(new InMemoryRedisClient(), chain);
    await manager.getNextNonce(scope);
    await manager.getNextNonce(scope);
    const n2 = await manager.getNextNonce(scope);
    await manager.releaseNonce(scope, n2);

    chain.pending = 1;
    await manager.catchUpToChain(scope);

    expect(await manager.getNextNonce(scope)).toBe(2); // the released one, still above the chain's floor
    expect(await manager.getNextNonce(scope)).toBe(3);
  });

  it('ensureInitialized seeds the counter from the chain once and allocates nothing', async () => {
    const chain = makeChainReader(7);
    const spy = vi.spyOn(chain, 'getPendingNonce');
    const manager = new NonceManager(new InMemoryRedisClient(), chain);

    await manager.ensureInitialized(scope);
    await manager.ensureInitialized(scope);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await manager.getNextNonce(scope)).toBe(7);
  });

  it('a second caller waits out a slow first chain read instead of giving up after a second', async () => {
    const slow: ChainNonceReader = {
      async getPendingNonce() {
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        return 0;
      },
    };
    const manager = new NonceManager(new InMemoryRedisClient(), slow);

    const nonces = await Promise.all([manager.getNextNonce(scope), manager.getNextNonce(scope)]);

    expect(nonces.sort()).toEqual([0, 1]);
  });

  it('validates scope input and rejects malformed addresses', async () => {
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(0);
    const manager = new NonceManager(redis, chain);

    await expect(
      manager.getNextNonce({ chainId: 1, walletAddress: 'not-an-address' } as NonceScope),
    ).rejects.toThrow();
  });
});

describe('NonceManager.healIfAhead', () => {
  function setup(chainPending: number) {
    const clock = { now: 1_000_000 };
    const redis = new InMemoryRedisClient();
    const chain = makeChainReader(chainPending);
    const manager = new NonceManager(redis, chain, { quietMs: 120_000, now: () => clock.now });
    return { clock, chain, manager };
  }

  it('pulls the counter back once the wallet has been quiet: sends the chain never got no longer block later ones', async () => {
    const { clock, manager } = setup(6);
    for (let i = 0; i < 5; i++) await manager.getNextNonce(scope); // 6..10 handed out, chain still at 6

    clock.now += 121_000;
    expect(await manager.healIfAhead(scope)).toEqual({ from: 11, to: 6 });
    expect(await manager.getNextNonce(scope)).toBe(6);
  });

  it('leaves a wallet in use alone: its counter is ahead only because a send is on its way', async () => {
    const { clock, manager } = setup(6);
    await manager.getNextNonce(scope);

    clock.now += 30_000;
    expect(await manager.healIfAhead(scope)).toBeNull();
    expect(await manager.getNextNonce(scope)).toBe(7);
  });

  it('does nothing when the chain counts the pending sends', async () => {
    const { clock, chain, manager } = setup(6);
    await manager.getNextNonce(scope);
    await manager.getNextNonce(scope);
    chain.pending = 8; // both are in the node's pool

    clock.now += 121_000;
    expect(await manager.healIfAhead(scope)).toBeNull();
    expect(await manager.getNextNonce(scope)).toBe(8);
  });

  it('drops released nonces above the chain too, so the next send uses the chain nonce', async () => {
    const { clock, manager } = setup(6);
    await manager.getNextNonce(scope); // 6
    const seven = await manager.getNextNonce(scope);
    await manager.getNextNonce(scope); // 8
    await manager.releaseNonce(scope, seven);

    clock.now += 121_000;
    expect(await manager.healIfAhead(scope)).toEqual({ from: 9, to: 6 });
    expect(await manager.getNextNonce(scope)).toBe(6);
    expect(await manager.getNextNonce(scope)).toBe(7);
  });

  it('does nothing for a wallet that was never counted, and reads no chain state for it', async () => {
    const { chain, manager } = setup(6);
    const read = vi.spyOn(chain, 'getPendingNonce');
    expect(await manager.healIfAhead(scope)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('skips the chain read for a wallet used inside the quiet period', async () => {
    const { chain, manager } = setup(6);
    await manager.getNextNonce(scope);
    const read = vi.spyOn(chain, 'getPendingNonce');
    await manager.healIfAhead(scope);
    expect(read).not.toHaveBeenCalled();
  });
});
