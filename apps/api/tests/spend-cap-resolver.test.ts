import { describe, expect, it } from 'vitest';
import { UserAccountService } from '@stryx/user-service';
import { SpendCapResolver, parsePerChainCaps } from '../src/spend-cap-resolver.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';

function makeResolver(platformDefaultCapWei?: bigint) {
  const repository = new InMemoryUserRepository();
  const userAccountService = new UserAccountService(repository);
  const resolver = new SpendCapResolver(userAccountService, platformDefaultCapWei);
  return { resolver, repository, userAccountService };
}

describe('SpendCapResolver', () => {
  it('resolves to null (unlimited) when the user has spendCapEnabled=false, e.g. the operator', async () => {
    const { resolver, repository } = makeResolver();
    const now = new Date();
    repository.seed({
      id: 'operator-1',
      email: 'operator@stryx.local',
      passwordHash: 'disabled:test-only',
      role: 'ADMIN',
      status: 'ACTIVE',
      dailySpendCapWei: null,
      spendCapEnabled: false,
      createdAt: now,
      updatedAt: now,
    });

    expect(await resolver.resolve('operator-1', 1)).toBeNull();
  });

  it("resolves to the user's own dailySpendCapWei when set", async () => {
    const { resolver, repository } = makeResolver();
    const now = new Date();
    repository.seed({
      id: 'user-1',
      email: 'user1@example.com',
      passwordHash: 'x',
      role: 'USER',
      status: 'ACTIVE',
      dailySpendCapWei: '2500000000000000000', // 2.5 ETH
      spendCapEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    expect(await resolver.resolve('user-1', 1)).toBe(2_500_000_000_000_000_000n);
  });

  it('falls back to the configured platform default when the user has no cap of their own', async () => {
    const { resolver, repository } = makeResolver(3_000_000_000_000_000_000n);
    const now = new Date();
    repository.seed({
      id: 'user-2',
      email: 'user2@example.com',
      passwordHash: 'x',
      role: 'USER',
      status: 'ACTIVE',
      dailySpendCapWei: null,
      spendCapEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    expect(await resolver.resolve('user-2', 1)).toBe(3_000_000_000_000_000_000n);
  });

  it('falls back to the hardcoded default when neither the user nor the platform has one configured', async () => {
    const { resolver, repository } = makeResolver(undefined);
    const now = new Date();
    repository.seed({
      id: 'user-3',
      email: 'user3@example.com',
      passwordHash: 'x',
      role: 'USER',
      status: 'ACTIVE',
      dailySpendCapWei: null,
      spendCapEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    expect(await resolver.resolve('user-3', 1)).toBe(1_000_000_000_000_000_000n);
  });

  it('fails CLOSED (applies the default cap, not unlimited) when the user cannot be found', async () => {
    const { resolver } = makeResolver(4_000_000_000_000_000_000n);

    expect(await resolver.resolve('does-not-exist', 1)).toBe(4_000_000_000_000_000_000n);
  });

  it('per chain: an ETH-token chain uses the ETH cap; another token never inherits it and defaults to 0', async () => {
    const { resolver, repository } = makeResolver(3_000_000_000_000_000_000n);
    const now = new Date();
    repository.seed({ id: 'u', email: 'u@example.com', passwordHash: 'x', role: 'USER', status: 'ACTIVE', dailySpendCapWei: '2000000000000000000', spendCapEnabled: true, createdAt: now, updatedAt: now });
    expect(await resolver.resolve('u', 8453)).toBe(2_000_000_000_000_000_000n); // Base pays ETH
    expect(await resolver.resolve('u', 2741)).toBe(2_000_000_000_000_000_000n); // Abstract pays ETH
    expect(await resolver.resolve('u', 56)).toBe(0n); // BNB: not the user's ETH cap
    expect(await resolver.resolve('u', 5042)).toBe(0n); // Arc USDC
  });

  it('per-chain defaults from DEFAULT_DAILY_SPEND_CAPS apply in that chain\'s token; the operator stays unlimited everywhere', async () => {
    const repository = new InMemoryUserRepository();
    const now = new Date();
    repository.seed({ id: 'u', email: 'u@example.com', passwordHash: 'x', role: 'USER', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: true, createdAt: now, updatedAt: now });
    repository.seed({ id: 'op', email: 'op@example.com', passwordHash: 'x', role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: false, createdAt: now, updatedAt: now });
    const resolver = new SpendCapResolver(new UserAccountService(repository), undefined, parsePerChainCaps('56=2, 5042=500.5'));
    expect(await resolver.resolve('u', 56)).toBe(2_000_000_000_000_000_000n);
    expect(await resolver.resolve('u', 5042)).toBe(500_500_000_000_000_000_000n);
    expect(await resolver.resolve('u', 1)).toBe(1_000_000_000_000_000_000n); // built-in 1 ETH
    expect(await resolver.resolve('op', 56)).toBeNull();
  });

  it("per-wallet caps: one wallet's share of the account's cap, unlimited for an unlimited account, off at 100%", () => {
    const service = new UserAccountService(new InMemoryUserRepository());
    const half = new SpendCapResolver(service, undefined, new Map());
    expect(half.walletCap(1_000_000_000_000_000_000n)).toBe(500_000_000_000_000_000n); // 50% by default
    expect(half.walletCap(3n)).toBe(1n); // rounded down
    expect(half.walletCap(0n)).toBe(0n);
    expect(half.walletCap(null)).toBeNull(); // the operator stays unlimited
    expect(new SpendCapResolver(service, undefined, new Map(), 25).walletCap(400n)).toBe(100n);
    expect(new SpendCapResolver(service, undefined, new Map(), 100).walletCap(400n)).toBeNull();
  });

  it('parsePerChainCaps refuses malformed entries and unknown chains', () => {
    expect(parsePerChainCaps(undefined).size).toBe(0);
    expect(() => parsePerChainCaps('56:2')).toThrow(/not chainId=amount/);
    expect(() => parsePerChainCaps('999999=1')).toThrow(/not a chain Stryx knows/);
  });
});
