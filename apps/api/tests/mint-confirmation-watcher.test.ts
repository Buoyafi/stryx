import { describe, expect, it } from 'vitest';
import { encodeEventTopics, getAddress, zeroAddress } from 'viem';
import { ERC721_ABI } from '@stryx/nft-engine';
import { noopLogger } from '@stryx/logger';
import type { UserId } from '@stryx/wallet-service';
import { processConfirmationJob, type MintConfirmationJob } from '../src/mint-confirmation-watcher.js';
import { NftLedgerService } from '../src/nft-ledger.service.js';
import { InMemoryNftLedgerRepository } from './fakes/in-memory-nft-ledger-repository.js';
import type { ChainServices } from '../src/chain-services.js';

const CHAIN_ID = 46630;
const CONTRACT = getAddress('0x1234567890123456789012345678901234567890');
const WALLET_ADDR = getAddress('0x1111111111111111111111111111111111111111');
const OWNER_ID = 'owner-1' as UserId;

function transferLog(tokenId: bigint) {
  const topics = encodeEventTopics({ abi: ERC721_ABI, eventName: 'Transfer', args: { from: zeroAddress, to: WALLET_ADDR, tokenId } });
  return { address: CONTRACT, topics, data: '0x' as `0x${string}` };
}

function makeChain(opts: { status: 'confirmed' | 'reverted'; logs?: unknown[] }): ChainServices {
  return {
    seaDropReader: {} as never,
    publicClient: {} as never,
    transactionEngine: {
      async waitForConfirmation(hash: `0x${string}`, nonce: number) {
        return { hash, nonce, status: opts.status, receipt: { logs: opts.logs ?? [] } };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const baseJob: MintConfirmationJob = {
  hash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
  nonce: 0,
  walletId: 'w1',
  walletAddress: WALLET_ADDR,
  chainId: CHAIN_ID,
  contract: CONTRACT,
  ownerId: OWNER_ID,
  standard: 'erc721',
};

describe('processConfirmationJob', () => {
  it('records a ledger row for a confirmed mint with a real Transfer log', async () => {
    const chain = makeChain({ status: 'confirmed', logs: [transferLog(42n)] });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);

    await processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, baseJob);

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({ walletId: 'w1', chainId: CHAIN_ID, contract: CONTRACT, tokenId: '42', standard: 'erc721' });
  });

  it('records one row per tokenId for a multi-quantity mint', async () => {
    const chain = makeChain({ status: 'confirmed', logs: [transferLog(1n), transferLog(2n), transferLog(3n)] });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);

    await processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, baseJob);

    expect(repo.rows.map((r) => r.tokenId)).toEqual(['1', '2', '3']);
  });

  it('records nothing for a reverted mint', async () => {
    const chain = makeChain({ status: 'reverted' });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);

    await processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, baseJob);

    expect(repo.rows).toHaveLength(0);
  });

  it('records nothing when confirmed but no Transfer log matches this wallet (defensive: should not normally happen)', async () => {
    const chain = makeChain({ status: 'confirmed', logs: [] });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);

    await processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, baseJob);

    expect(repo.rows).toHaveLength(0);
  });

  it('never throws when the chain is no longer configured', async () => {
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);

    await expect(processConfirmationJob(new Map(), ledger, noopLogger, baseJob)).resolves.toBeUndefined();
    expect(repo.rows).toHaveLength(0);
  });
});

describe('processConfirmationJob: vault auto-drain', () => {
  const VAULT = getAddress('0x9999999999999999999999999999999999999999');

  function fakeTransferService(transfer: (params: unknown) => Promise<unknown>) {
    return { transfer } as never;
  }

  it('does not attempt a drain when no vault settings/transfer service are wired up', async () => {
    const chain = makeChain({ status: 'confirmed', logs: [transferLog(1n)] });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);

    await processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, baseJob);
    expect(repo.rows[0]?.drainError).toBeNull();
  });

  it('does not attempt a drain when the collection has no vault configured', async () => {
    const chain = makeChain({ status: 'confirmed', logs: [transferLog(1n)] });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);
    let called = false;
    const vaultSettings = { get: async () => ({ enabled: false, vaultAddress: null }) } as never;
    const nftTransferService = fakeTransferService(async () => {
      called = true;
      return { ok: true, results: [] };
    });

    await processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, baseJob, vaultSettings, nftTransferService);
    expect(called).toBe(false);
  });

  it('drains a confirmed mint to the configured vault address when enabled', async () => {
    const chain = makeChain({ status: 'confirmed', logs: [transferLog(1n)] });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);
    let receivedParams: unknown;
    const vaultSettings = { get: async () => ({ enabled: true, vaultAddress: VAULT }) } as never;
    const nftTransferService = fakeTransferService(async (params) => {
      receivedParams = params;
      return { ok: true, results: [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', status: 'sent' }] };
    });

    await processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, baseJob, vaultSettings, nftTransferService);

    expect(receivedParams).toMatchObject({
      ownerId: OWNER_ID,
      chainId: CHAIN_ID,
      destination: VAULT,
      items: [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }],
    });
  });

  it('records a drain failure on the ledger row when the transfer fails, without throwing', async () => {
    const chain = makeChain({ status: 'confirmed', logs: [transferLog(1n)] });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);
    const vaultSettings = { get: async () => ({ enabled: true, vaultAddress: VAULT }) } as never;
    const nftTransferService = fakeTransferService(async () => ({
      ok: false,
      results: [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', status: 'failed', error: 'Simulation reverted: boom' }],
    }));

    await expect(
      processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, baseJob, vaultSettings, nftTransferService),
    ).resolves.toBeUndefined();

    expect(repo.rows[0]?.drainError).toBe('Simulation reverted: boom');
    expect(repo.rows[0]?.drainFailedAt).toBeInstanceOf(Date);
  });
  const drainRig = (transfer: (params: unknown) => Promise<unknown>) => {
    const chain = makeChain({ status: 'confirmed', logs: [transferLog(1n), transferLog(2n)] });
    const repo = new InMemoryNftLedgerRepository();
    const vaultSettings = { get: async () => ({ enabled: true, vaultAddress: VAULT }) } as never;
    const run = () => processConfirmationJob(new Map([[CHAIN_ID, chain]]), new NftLedgerService(repo), noopLogger, baseJob, vaultSettings, fakeTransferService(transfer));
    return { repo, run };
  };

  it('records it when the send may or may not have gone out', async () => {
    const { repo, run } = drainRig(async () => ({
      ok: false,
      results: [
        { walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', status: 'sent' },
        { walletId: 'w1', contract: CONTRACT, tokenId: '2', standard: 'erc721', status: 'unknown', error: 'May have been sent. Check it before sending again.' },
      ],
    }));
    await run();
    expect(repo.rows.find((r) => r.tokenId === '1')?.drainError).toBeNull();
    expect(repo.rows.find((r) => r.tokenId === '2')?.drainError).toMatch(/May have been sent/);
  });

  it('records it for every token when the move was refused before anything was sent', async () => {
    const { repo, run } = drainRig(async () => ({ ok: false, preflightError: 'destination_is_source', detail: 'Destination cannot be one of the source wallets.', results: [] }));
    await run();
    expect(repo.rows.map((r) => r.drainError)).toEqual(['Destination cannot be one of the source wallets.', 'Destination cannot be one of the source wallets.']);
  });

  it('records it for every token when the move itself threw, with no RPC address in the text', async () => {
    const { repo, run } = drainRig(async () => {
      throw new Error('connect failed https://rpc.example.com/v2/SECRETKEY');
    });
    await expect(run()).resolves.toBeUndefined();
    expect(repo.rows.every((r) => r.drainError !== null && !r.drainError.includes('SECRETKEY'))).toBe(true);
  });

  it('a token the chain says already left the wallet is not reported as a failure', async () => {
    const { repo, run } = drainRig(async () => ({
      ok: false,
      results: [
        { walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', status: 'skipped', error: 'No longer held by this wallet.' },
        { walletId: 'w1', contract: CONTRACT, tokenId: '2', standard: 'erc721', status: 'failed', error: 'Could not check who holds it, so it was not sent: timeout' },
      ],
    }));
    await run();
    expect(repo.rows.find((r) => r.tokenId === '1')?.drainError).toBeNull();
    expect(repo.rows.find((r) => r.tokenId === '2')?.drainError).toMatch(/Could not check who holds it/);
  });
});

describe('processConfirmationJob: a mint that is slow to land', () => {
  it('throws while the receipt is not there, so the job is tried again, and writes nothing', async () => {
    const chain = makeChain({ status: 'confirmed' });
    chain.transactionEngine.waitForConfirmation = async () => {
      throw new Error('Timed out while waiting for transaction to be confirmed.');
    };
    const repo = new InMemoryNftLedgerRepository();
    await expect(processConfirmationJob(new Map([[CHAIN_ID, chain]]), new NftLedgerService(repo), noopLogger, baseJob)).rejects.toThrow(/Timed out/);
    expect(repo.rows).toHaveLength(0);
  });

  it('a retry after the rows were written goes straight to the vault step: no second wait, no second set of rows', async () => {
    const chain = makeChain({ status: 'confirmed', logs: [transferLog(1n)] });
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);
    const vaultSettings = { get: async () => ({ enabled: true, vaultAddress: getAddress('0x9999999999999999999999999999999999999999') }) } as never;
    let saved: { tokenId: string; amount: string }[] | undefined;
    let attempts = 0;
    const transfer = { transfer: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first try dies');
      return { ok: true, results: [{ walletId: 'w1', contract: CONTRACT, tokenId: '1', standard: 'erc721', status: 'sent' }] };
    } } as never;
    const checkpoint = { recorded: async (tokens: { tokenId: string; amount: string }[]) => void (saved = tokens) };

    await processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, baseJob, vaultSettings, transfer, checkpoint);
    expect(saved).toEqual([{ tokenId: '1', amount: '1' }]);
    expect(repo.rows).toHaveLength(1);

    // Tried again with what was saved: the chain is not asked, and nothing is written twice.
    chain.transactionEngine.waitForConfirmation = async () => {
      throw new Error('must not be called again');
    };
    await processConfirmationJob(new Map([[CHAIN_ID, chain]]), ledger, noopLogger, { ...baseJob, recorded: saved! }, vaultSettings, transfer, checkpoint);
    expect(repo.rows).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});
