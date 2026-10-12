import { describe, expect, it } from 'vitest';
import type { UserId } from '@stryx/wallet-service';
import { EmergencyStopActiveError, RpcUnavailableError } from '@stryx/transaction-engine';
import { NftTransferService, type NftTransferItem } from '../src/nft-transfer.service.js';
import { NftLedgerService } from '../src/nft-ledger.service.js';
import { InMemoryNftLedgerRepository } from './fakes/in-memory-nft-ledger-repository.js';
import type { ChainServices } from '../src/chain-services.js';

const CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890' as `0x${string}`;
const WALLET_ADDR = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const DESTINATION = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const OWNER_ID = 'owner-1' as UserId;

function makeWalletService(addresses: Record<string, string> = { w1: WALLET_ADDR }) {
  return {
    async getWalletSummary(_ownerId: unknown, id: string) {
      return { id, address: addresses[id] };
    },
  } as never;
}

function makeChain(opts: {
  owners?: Record<string, string>; // tokenId -> current owner
  balances?: Record<string, bigint>; // tokenId -> current balance
  emergencyStopAtCall?: boolean;
  rpcUnavailableAtCall?: boolean;
  failAtCall?: boolean;
  /** The chain does not answer the ownership read at all. */
  ownerReadFails?: boolean;
  /** What the chain does with a transfer that was sent. */
  reverts?: boolean;
  neverMined?: boolean;
}): ChainServices {
  let nonce = 0;
  return {
    seaDropReader: {} as never,
    publicClient: {
      async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
        if (functionName === 'ownerOf') {
          const tokenId = (args[0] as bigint).toString();
          const owner = opts.owners?.[tokenId];
          if (opts.ownerReadFails) throw new Error('HTTP request failed. URL: https://rpc.example.com/v2/SECRETKEY Details: fetch failed');
          if (!owner) throw new Error('execution reverted: nonexistent token');
          return owner;
        }
        if (functionName === 'balanceOf') {
          const tokenId = (args[1] as bigint).toString();
          return opts.balances?.[tokenId] ?? 0n;
        }
        throw new Error(`unexpected readContract call: ${functionName}`);
      },
    } as never,
    transactionEngine: {
      async executeTransaction() {
        if (opts.emergencyStopAtCall) {
          throw new EmergencyStopActiveError(
            { chainId: CHAIN_ID, walletId: 'w1', walletAddress: WALLET_ADDR, ownerId: OWNER_ID, spendCapWei: null },
            'pre-sign',
          );
        }
        if (opts.rpcUnavailableAtCall) {
          throw new RpcUnavailableError(
            { chainId: CHAIN_ID, walletId: 'w1', walletAddress: WALLET_ADDR, ownerId: OWNER_ID, spendCapWei: null },
            'pre-simulation',
            new Error('timeout'),
          );
        }
        if (opts.failAtCall) throw new Error('broadcast failed');
        return { hash: `0xhash${nonce}`, nonce: nonce++, status: 'broadcast' };
      },
      async waitForConfirmation(hash: `0x${string}`, n: number) {
        if (opts.neverMined) throw new Error('Timed out while waiting for transaction to be confirmed.');
        return { hash, nonce: n, status: opts.reverts ? 'reverted' : 'confirmed', receipt: { logs: [] } };
      },
    } as never,
  };
}

describe('NftTransferService: preflight', () => {
  it('rejects an empty item list', async () => {
    const service = new NftTransferService(makeWalletService(), new Map(), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items: [] });
    expect(outcome).toMatchObject({ ok: false, preflightError: 'no_items' });
  });

  it('rejects an unconfigured chain', async () => {
    const service = new NftTransferService(makeWalletService(), new Map(), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }];
    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });
    expect(outcome).toMatchObject({ ok: false, preflightError: 'unsupported_chain' });
  });

  it('rejects a destination that is one of the source wallets', async () => {
    const chain = makeChain({ owners: { '1': WALLET_ADDR } });
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: WALLET_ADDR, items });

    expect(outcome).toMatchObject({ ok: false, preflightError: 'destination_is_source' });
  });
});

describe('NftTransferService: sending', () => {
  it('sends an ERC-721 item the wallet still owns, and marks the ledger row transferred', async () => {
    const chain = makeChain({ owners: { '1': WALLET_ADDR } });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);
    await ledger.recordMint({ walletId: 'w1', ownerId: 'owner-1', chainId: CHAIN_ID, contract: CONTRACT, standard: 'erc721' }, [{ tokenId: '1', amount: '1' }]);
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), ledger);
    const items: NftTransferItem[] = [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });

    expect(outcome.ok).toBe(true);
    expect(outcome.results[0]).toMatchObject({ tokenId: '1', status: 'sent' });
    await service.idle();
    expect(repo.rows[0]!.transferredAt).not.toBeNull();
  });

  const mintedThenSent = async (chain: ChainServices, contractAsSent: `0x${string}` = CONTRACT, onReverted?: (item: NftTransferItem, hash: string) => Promise<void>, recordedAs: string = CONTRACT) => {
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);
    await ledger.recordMint({ walletId: 'w1', ownerId: 'owner-1', chainId: CHAIN_ID, contract: recordedAs, standard: 'erc721' }, [{ tokenId: '1', amount: '1' }]);
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), ledger);
    const outcome = await service.transfer({
      ownerId: OWNER_ID,
      chainId: CHAIN_ID,
      destination: DESTINATION,
      items: [{ walletId: 'w1', contract: contractAsSent, tokenId: '1', standard: 'erc721', amount: '1' }],
      ...(onReverted ? { onReverted } : {}),
    });
    await service.idle();
    return { repo, outcome };
  };

  it('a transfer that the chain reverts leaves the token on the ledger as still held, and says so', async () => {
    const reverted: string[] = [];
    const { repo, outcome } = await mintedThenSent(makeChain({ owners: { '1': WALLET_ADDR }, reverts: true }), CONTRACT, async (item, hash) => void reverted.push(`${item.tokenId}:${hash}`));
    expect(outcome.results[0]).toMatchObject({ status: 'sent' });
    expect(repo.rows[0]!.transferredAt).toBeNull();
    expect(reverted).toEqual(['1:0xhash0']);
  });

  it('a transfer that is never mined leaves the token on the ledger as still held', async () => {
    const { repo } = await mintedThenSent(makeChain({ owners: { '1': WALLET_ADDR }, neverMined: true }));
    expect(repo.rows[0]!.transferredAt).toBeNull();
  });

  it('marks the row whatever letter case the contract address arrives in', async () => {
    // Recorded as the mint wrote it (mixed case), moved as an indexer returns it (lower case).
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    const { repo } = await mintedThenSent(makeChain({ owners: { '1': WALLET_ADDR } }), mixed.toLowerCase() as `0x${string}`, undefined, mixed);
    expect(repo.rows[0]!.transferredAt).not.toBeNull();
    expect(repo.rows[0]!.transferredTo).toBe(DESTINATION);
  });

  it('a row still marked held for a token the chain says someone else has is put right when a move is tried', async () => {
    const elsewhere = '0x' + '7'.repeat(40);
    const { repo, outcome } = await mintedThenSent(makeChain({ owners: { '1': elsewhere } }));
    expect(outcome.results[0]).toMatchObject({ status: 'skipped' });
    expect(repo.rows[0]!.transferredTo).toBe(elsewhere);
    expect(repo.rows[0]!.transferredAt).not.toBeNull();
  });

  it('skips an ERC-721 item the wallet no longer owns, without sending', async () => {
    const chain = makeChain({ owners: { '1': DESTINATION } }); // already moved elsewhere
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });

    expect(outcome.results[0]).toMatchObject({ status: 'skipped' });
    expect(outcome.ok).toBe(false);
  });

  it('skips an ERC-1155 item whose balance is less than the requested amount', async () => {
    const chain = makeChain({ balances: { '9': 1n } });
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [{ walletId: 'w1', contract: CONTRACT, tokenId: '9', standard: 'erc1155', amount: '3' }];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });

    expect(outcome.results[0]).toMatchObject({ status: 'skipped' });
  });

  it('sends an ERC-1155 item when the held balance covers the requested amount', async () => {
    const chain = makeChain({ balances: { '9': 5n } });
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [{ walletId: 'w1', contract: CONTRACT, tokenId: '9', standard: 'erc1155', amount: '3' }];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });

    expect(outcome.results[0]).toMatchObject({ status: 'sent' });
  });

  it('a nonexistent/reverting tokenId read is treated as not held, not a thrown error', async () => {
    const chain = makeChain({ owners: {} }); // ownerOf throws for any tokenId
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });

    expect(outcome.results[0]).toMatchObject({ status: 'skipped' });
  });

  it('a chain that does not answer is not "no longer held": the item fails, says why, and nothing is sent', async () => {
    const chain = makeChain({ owners: { '1': WALLET_ADDR }, ownerReadFails: true });
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });

    expect(outcome.ok).toBe(false);
    expect(outcome.results[0]).toMatchObject({ status: 'failed' });
    expect(outcome.results[0]!.error).toMatch(/Could not check who holds it/);
    expect(outcome.results[0]!.error).not.toContain('SECRETKEY');
    expect(outcome.results[0]!.hash).toBeUndefined();
  });

  it('a per-item broadcast failure does not halt the rest of the batch', async () => {
    const chain = makeChain({ owners: { '1': WALLET_ADDR, '2': WALLET_ADDR }, failAtCall: true });
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [
      { walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' },
      { walletId: 'w1', contract: CONTRACT, tokenId: '2', standard: 'erc721', amount: '1' },
    ];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r) => r.status === 'failed')).toBe(true);
    expect(outcome.haltReason).toBeUndefined();
  });

  it('an emergency stop halts the batch: remaining items are marked failed, not attempted', async () => {
    const chain = makeChain({ owners: { '1': WALLET_ADDR, '2': WALLET_ADDR }, emergencyStopAtCall: true });
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [
      { walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' },
      { walletId: 'w1', contract: CONTRACT, tokenId: '2', standard: 'erc721', amount: '1' },
    ];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });

    expect(outcome.haltReason).toBe('emergency_stop');
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[1]!.error).toMatch(/emergency stop/i);
  });

  it('an unreachable chain halts the batch with rpc_unavailable', async () => {
    const chain = makeChain({ owners: { '1': WALLET_ADDR, '2': WALLET_ADDR }, rpcUnavailableAtCall: true });
    const service = new NftTransferService(makeWalletService(), new Map([[CHAIN_ID, chain]]), new NftLedgerService(new InMemoryNftLedgerRepository()));
    const items: NftTransferItem[] = [
      { walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' },
      { walletId: 'w1', contract: CONTRACT, tokenId: '2', standard: 'erc721', amount: '1' },
    ];

    const outcome = await service.transfer({ ownerId: OWNER_ID, chainId: CHAIN_ID, destination: DESTINATION, items });

    expect(outcome.haltReason).toBe('rpc_unavailable');
  });
});
