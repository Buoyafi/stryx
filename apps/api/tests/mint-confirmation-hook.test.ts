import { describe, expect, it, vi } from 'vitest';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { MintExecutionService } from '../src/mint-execution.service.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import { FakeOpenSeaDropClient } from './fakes/fake-opensea-drop-client.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';
import type { ChainServices } from '../src/chain-services.js';
import type { MintConfirmationWatcher } from '../src/mint-confirmation-watcher.js';

const TEST_CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890' as `0x${string}`;

function fakeSeaDropReader() {
  return {
    async getPublicDrop() {
      return { mintPrice: 10_000_000_000_000n, startTime: 1, endTime: 9_999_999_999, maxTotalMintableByWallet: 5, feeBps: 500, restrictFeeRecipients: false };
    },
    async isPublicStageActive() {
      return true;
    },
    async getAllowedFeeRecipients() {
      return ['0x0000a26b00c1f0df003000390027140000faa719'];
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeTransactionEngine(opts: { throws?: Error } = {}) {
  return {
    async executeTransaction() {
      if (opts.throws) throw opts.throws;
      return { hash: '0x' + '11'.repeat(32), nonce: 3, status: 'broadcast' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function buildService(watcher: MintConfirmationWatcher, opts: { throws?: Error } = {}) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);
  const wallet = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

  const chainServices = new Map<number, ChainServices>([
    [TEST_CHAIN_ID, { seaDropReader: fakeSeaDropReader(), transactionEngine: fakeTransactionEngine(opts), publicClient: {} as never }],
  ]);

  const service = new MintExecutionService(
    walletService,
    chainServices,
    new InMemoryAllowListStore(),
    new FakeOpenSeaDropClient(),
    makePermissiveSpendCapResolver(),
    watcher,
  );

  return { service, walletId: wallet.id, walletAddress: wallet.address };
}

describe('MintExecutionService: mint-confirmation-watcher hook', () => {
  it('enqueues a confirmation job with the right fields after a successful public mint', async () => {
    const watcher = { enqueue: vi.fn(async () => undefined) } as unknown as MintConfirmationWatcher;
    const { service, walletId, walletAddress } = await buildService(watcher);

    const outcome = await service.executePublicMint({
      ownerId: RESERVED_OPERATOR_USER_ID,
      walletId,
      nftContract: CONTRACT,
      chainId: TEST_CHAIN_ID,
      quantity: 1,
    });

    expect(outcome.ok).toBe(true);
    expect(watcher.enqueue).toHaveBeenCalledOnce();
    expect(watcher.enqueue).toHaveBeenCalledWith({
      hash: '0x' + '11'.repeat(32),
      nonce: 3,
      walletId,
      walletAddress: walletAddress.toLowerCase(),
      chainId: TEST_CHAIN_ID,
      contract: CONTRACT,
      ownerId: RESERVED_OPERATOR_USER_ID,
      standard: 'erc721',
    });
  });

  it('never enqueues a confirmation job when the mint fails', async () => {
    const watcher = { enqueue: vi.fn(async () => undefined) } as unknown as MintConfirmationWatcher;
    const { service, walletId } = await buildService(watcher, { throws: new Error('broadcast failed') });

    await expect(
      service.executePublicMint({ ownerId: RESERVED_OPERATOR_USER_ID, walletId, nftContract: CONTRACT, chainId: TEST_CHAIN_ID, quantity: 1 }),
    ).rejects.toThrow('broadcast failed');

    expect(watcher.enqueue).not.toHaveBeenCalled();
  });

  it('does not fail the mint if enqueueing the confirmation job itself throws', async () => {
    const watcher = { enqueue: vi.fn(async () => { throw new Error('redis down'); }) } as unknown as MintConfirmationWatcher;
    const { service, walletId } = await buildService(watcher);

    const outcome = await service.executePublicMint({
      ownerId: RESERVED_OPERATOR_USER_ID,
      walletId,
      nftContract: CONTRACT,
      chainId: TEST_CHAIN_ID,
      quantity: 1,
    });

    expect(outcome.ok).toBe(true);
  });

  it('works fine with no watcher configured at all (optional dependency)', async () => {
    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);
    const walletService = new WalletService(repository, walletKeyService, kms.keyId);
    const wallet = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);
    const chainServices = new Map<number, ChainServices>([
      [TEST_CHAIN_ID, { seaDropReader: fakeSeaDropReader(), transactionEngine: fakeTransactionEngine(), publicClient: {} as never }],
    ]);
    const service = new MintExecutionService(walletService, chainServices, new InMemoryAllowListStore(), new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());

    const outcome = await service.executePublicMint({ ownerId: RESERVED_OPERATOR_USER_ID, walletId: wallet.id, nftContract: CONTRACT, chainId: TEST_CHAIN_ID, quantity: 1 });

    expect(outcome.ok).toBe(true);
  });
});
