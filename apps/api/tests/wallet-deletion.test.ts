import { describe, expect, it } from 'vitest';
import { TimeoutError } from 'viem';
import { makeNftHoldingsCheck, makeWalletDeletionChecker, type NftCheckChain, type WalletDeletionDeps } from '../src/wallet-deletion.js';
import { InMemoryNftLedgerRepository } from './fakes/in-memory-nft-ledger-repository.js';

const ADDRESS = '0x' + 'a'.repeat(40);
const wallet = (origin: 'GENERATED' | 'IMPORTED') => ({ id: 'w1', address: ADDRESS, origin, ownerId: 'u1' as never });
const empty = [{ chainName: 'Base', wei: '0', formatted: '0' }];
const funded = [{ chainName: 'Base', wei: '5000000000000000', formatted: '0.005' }, { chainName: 'Polygon', wei: '0', formatted: '0' }];
const unreadable = [{ chainName: 'Base', wei: '0', formatted: '0' }, { chainName: 'Monad', wei: '0', formatted: '0', error: 'RPC did not answer' }];

function checker(balances: Awaited<ReturnType<WalletDeletionDeps['getBalances']>>, extra: Partial<WalletDeletionDeps> = {}) {
  return makeWalletDeletionChecker({ getBalances: async () => balances, ...extra });
}

describe('when a wallet may be deleted', () => {
  it('an empty wallet goes, whoever made it', async () => {
    for (const origin of ['GENERATED', 'IMPORTED'] as const) {
      expect(await checker(empty)(wallet(origin), { keySaved: false })).toMatchObject({ canDelete: true, reason: 'empty', funds: [] });
    }
  });

  it('a funded wallet whose only key is in Stryx is refused, with what it holds', async () => {
    const check = await checker(funded)(wallet('GENERATED'), { keySaved: true });
    expect(check).toMatchObject({ canDelete: false, reason: 'has_funds', keyElsewhere: null, funds: [{ chainName: 'Base', amount: '0.005' }] });
    expect(check.message).toMatch(/0.005 on Base.*only copy of its key/);
  });

  it('a funded imported wallet goes once the owner confirms they have its key saved', async () => {
    const check = checker(funded);
    expect(await check(wallet('IMPORTED'), { keySaved: false })).toMatchObject({ canDelete: false, reason: 'confirm_key', keyElsewhere: 'imported' });
    expect(await check(wallet('IMPORTED'), { keySaved: true })).toMatchObject({ canDelete: true, reason: 'key_elsewhere' });
  });

  it('so does a generated wallet whose key its owner exported', async () => {
    const check = checker(funded, { keyExported: async (id) => id === 'w1' });
    expect(await check(wallet('GENERATED'), { keySaved: false })).toMatchObject({ canDelete: false, reason: 'confirm_key', keyElsewhere: 'exported' });
    expect(await check(wallet('GENERATED'), { keySaved: true })).toMatchObject({ canDelete: true, reason: 'key_elsewhere' });
  });

  it('a chain that cannot be read blocks a key only Stryx holds, not one saved elsewhere', async () => {
    expect(await checker(unreadable)(wallet('GENERATED'), { keySaved: true })).toMatchObject({ canDelete: false, reason: 'balance_unreadable' });
    expect(await checker(unreadable)(wallet('IMPORTED'), { keySaved: true })).toMatchObject({ canDelete: true, reason: 'key_elsewhere' });
  });

  it('a wallet a scheduled mint uses is refused first, even when empty', async () => {
    const check = await checker(empty, { scheduledUses: async () => 2 })(wallet('IMPORTED'), { keySaved: true });
    expect(check).toMatchObject({ canDelete: false, reason: 'scheduled', scheduled: 2 });
    expect(check.message).toMatch(/2 scheduled mints use this wallet/);
  });

  it('a wallet holding NFTs but no gas money is not empty: refused while Stryx has the only key', async () => {
    const nfts = { getNftHoldings: async () => [{ chainName: 'Base', held: true }] };
    const check = await checker(empty, nfts)(wallet('GENERATED'), { keySaved: true });
    expect(check).toMatchObject({ canDelete: false, reason: 'has_funds', funds: [{ chainName: 'Base', amount: 'NFTs' }] });
    expect(check.message).toMatch(/NFTs on Base.*only copy of its key/);
    expect(await checker(empty, nfts)(wallet('IMPORTED'), { keySaved: true })).toMatchObject({ canDelete: true, reason: 'key_elsewhere' });
  });

  it('NFTs that cannot be read block a key only Stryx holds', async () => {
    const nfts = { getNftHoldings: async () => [{ chainName: 'Base', held: false, error: 'NFTs could not be read.' }] };
    expect(await checker(empty, nfts)(wallet('GENERATED'), { keySaved: false })).toMatchObject({ canDelete: false, reason: 'balance_unreadable' });
  });

  it('no chain to ask is not an empty wallet', async () => {
    expect(await checker([])(wallet('GENERATED'), { keySaved: false })).toMatchObject({ canDelete: false, reason: 'balance_unreadable' });
    expect(await checker([])(wallet('IMPORTED'), { keySaved: true })).toMatchObject({ canDelete: true, reason: 'key_elsewhere' });
  });
});

describe('whether a wallet holds NFTs', () => {
  const CONTRACT = '0x' + 'c'.repeat(40);
  const target = { id: 'w1', address: ADDRESS as `0x${string}` };
  const token = (over: Record<string, unknown> = {}) => ({ walletId: 'w1', ownerId: 'u1', chainId: 8453, contract: CONTRACT, tokenId: '7', standard: 'erc721' as const, amount: '1', ...over });
  /** A chain where `ownerOf` answers `owner` (or throws what the test gives it). */
  const chain = (owner: string | Error, indexer?: NftCheckChain['indexer']): NftCheckChain => ({
    chainId: 8453,
    chainName: 'Base',
    publicClient: { readContract: async () => { if (owner instanceof Error) throw owner; return owner; } } as never,
    ...(indexer ? { indexer } : {}),
  });

  it('the live indexer answers when there is one, including NFTs Stryx never minted', async () => {
    const indexer = { listHoldings: async () => [{ contract: CONTRACT, tokenId: '1', standard: 'erc721' as const, amount: '1' }] };
    const check = makeNftHoldingsCheck({ chains: [chain('0x' + '0'.repeat(40), indexer)], ledger: new InMemoryNftLedgerRepository() });
    expect(await check(target)).toEqual([{ chainName: 'Base', held: true }]);
  });

  it('without an indexer, a token minted into the wallet counts while the chain says it is still there', async () => {
    const ledger = new InMemoryNftLedgerRepository();
    await ledger.create(token());
    expect(await makeNftHoldingsCheck({ chains: [chain(ADDRESS)], ledger })(target)).toEqual([{ chainName: 'Base', held: true }]);
    expect(await makeNftHoldingsCheck({ chains: [chain('0x' + 'b'.repeat(40))], ledger })(target)).toEqual([{ chainName: 'Base', held: false }]);
  });

  it('a token Stryx moved to this address counts too, and the indexer failing falls back to it', async () => {
    const ledger = new InMemoryNftLedgerRepository();
    await ledger.create(token({ walletId: 'other-wallet' }));
    await ledger.markTransferred({ chainId: 8453, contract: CONTRACT, tokenId: '7', walletId: 'other-wallet' }, ADDRESS.toUpperCase().replace('0X', '0x'));
    const failing = { listHoldings: async () => { throw new Error('indexer down'); } };
    expect(await makeNftHoldingsCheck({ chains: [chain(ADDRESS, failing)], ledger })(target)).toEqual([{ chainName: 'Base', held: true }]);
  });

  it('a burned token is not held; an unreachable chain is unreadable, not empty', async () => {
    const ledger = new InMemoryNftLedgerRepository();
    await ledger.create(token());
    expect(await makeNftHoldingsCheck({ chains: [chain(new Error('execution reverted'))], ledger })(target)).toEqual([{ chainName: 'Base', held: false }]);
    const down = await makeNftHoldingsCheck({ chains: [chain(new TimeoutError({ body: {}, url: 'http://rpc.example' }))], ledger })(target);
    expect(down).toEqual([{ chainName: 'Base', held: false, error: 'NFTs could not be read.' }]);
  });
});
