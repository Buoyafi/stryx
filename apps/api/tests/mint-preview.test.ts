import { describe, expect, it } from 'vitest';
import { TimeoutError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { SeaDropAllowListTree, type AllowListEntry } from '@stryx/eligibility';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { MintExecutionService } from '../src/mint-execution.service.js';
import { MintPreviewService, type WalletPreviewRow } from '../src/mint-preview.service.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import { OpenSeaDropError } from '../src/opensea-drop-client.js';
import { FakeOpenSeaDropClient } from './fakes/fake-opensea-drop-client.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';
import type { ChainServices } from '../src/chain-services.js';

const CHAIN_ID = 46630;
const NFT_CONTRACT = '0x1234567890123456789012345678901234567890' as `0x${string}`;

const baseMintParams = {
  mintPrice: 0n,
  maxTotalMintableByWallet: 10,
  startTime: 1_700_000_000,
  endTime: 2_000_000_000,
  dropStageIndex: 1,
  maxTokenSupplyForStage: 1000n,
  feeBps: 0,
  restrictFeeRecipients: false,
};

function fakePublicChain(opts: { mintedByAddress?: Record<string, number>; active?: boolean; getBalanceFails?: boolean }): ChainServices {
  return {
    seaDropReader: {
      async getPublicDrop() {
        return { mintPrice: 0n, startTime: 1_700_000_000, endTime: 2_000_000_000, maxTotalMintableByWallet: 10, feeBps: 0, restrictFeeRecipients: false };
      },
      async isPublicStageActive() {
        return opts.active ?? true;
      },
      async getMintStats(_scope: unknown, minter: `0x${string}`) {
        return { minterNumMinted: opts.mintedByAddress?.[minter.toLowerCase()] ?? 0, currentTotalSupply: 0n, maxSupply: 1000n };
      },
      async getAllowListMerkleRoot() {
        return `0x${'00'.repeat(32)}` as `0x${string}`;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    transactionEngine: {} as never,
    publicClient: {
      async getBalance() {
        if (opts.getBalanceFails) throw new Error('balance read failed');
        return 1_000_000_000_000_000_000n;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

async function buildRig(chain: ChainServices, allowListStoreEntries?: readonly AllowListEntry[]) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
  const allowListStore = new InMemoryAllowListStore();
  if (allowListStoreEntries) await allowListStore.set('drop-1', allowListStoreEntries);

  return { walletService, chainServices, allowListStore };
}

async function importWallet(walletService: WalletService, keyByte: number) {
  const privateKey = ('0x' + String(keyByte).padStart(2, '0').repeat(32)) as `0x${string}`;
  const address = privateKeyToAccount(privateKey).address;
  const wallet = await walletService.importWallet({ privateKey, tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);
  return { id: wallet.id, address: address.toLowerCase() as `0x${string}` };
}

function rowFor(results: readonly WalletPreviewRow[], walletId: string): WalletPreviewRow {
  const row = results.find((r) => r.walletId === walletId);
  if (!row) throw new Error(`no row for wallet ${walletId}`);
  return row;
}

describe('MintPreviewService: public stage', () => {
  it('reports minted/limit/remaining per wallet, and marks a wallet already at its limit as not eligible without touching the chain to mint anything', async () => {
    const rig = await buildRig(fakePublicChain({}));
    const fresh = await importWallet(rig.walletService, 1);
    const atLimit = await importWallet(rig.walletService, 2);
    const chain = fakePublicChain({ mintedByAddress: { [fresh.address]: 3, [atLimit.address]: 10 } });
    rig.chainServices.set(CHAIN_ID, chain);

    const mintExecutionService = new MintExecutionService(rig.walletService, rig.chainServices, rig.allowListStore, new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());
    const preview = new MintPreviewService(rig.walletService, rig.chainServices, mintExecutionService);

    const outcome = await preview.preview({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [fresh.id, atLimit.id], stage: 'public' });

    const freshRow = rowFor(outcome.results, fresh.id);
    expect(freshRow.minted).toBe(3);
    expect(freshRow.limit).toBe(10);
    expect(freshRow.remaining).toBe(7);
    expect(freshRow.eligible).toBe('eligible');

    const atLimitRow = rowFor(outcome.results, atLimit.id);
    expect(atLimitRow.remaining).toBe(0);
    expect(atLimitRow.eligible).toBe('not_eligible');
    expect(atLimitRow.reason).toBe('at_mint_limit');
  });

  it('marks every wallet not eligible (stage_not_active), not merely absent, when the public stage is not live', async () => {
    const rig = await buildRig(fakePublicChain({ active: false }));
    const a = await importWallet(rig.walletService, 1);
    const mintExecutionService = new MintExecutionService(rig.walletService, rig.chainServices, rig.allowListStore, new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());
    const preview = new MintPreviewService(rig.walletService, rig.chainServices, mintExecutionService);

    const outcome = await preview.preview({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id], stage: 'public' });

    expect(rowFor(outcome.results, a.id).eligible).toBe('not_eligible');
    expect(rowFor(outcome.results, a.id).reason).toBe('stage_not_active');
  });

  it('degrades a single wallet\'s balance-read failure to "0" rather than failing the whole row', async () => {
    const rig = await buildRig(fakePublicChain({ getBalanceFails: true }));
    const a = await importWallet(rig.walletService, 1);
    const mintExecutionService = new MintExecutionService(rig.walletService, rig.chainServices, rig.allowListStore, new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());
    const preview = new MintPreviewService(rig.walletService, rig.chainServices, mintExecutionService);

    const outcome = await preview.preview({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id], stage: 'public' });

    expect(rowFor(outcome.results, a.id).balanceWei).toBe('0');
    expect(rowFor(outcome.results, a.id).eligible).toBe('eligible'); // the balance hiccup didn't hide the real eligibility answer
  });

  it('a stage-wide RPC failure marks every row unknown/rpc_unavailable rather than failing the whole request', async () => {
    const rig = await buildRig(fakePublicChain({}));
    const a = await importWallet(rig.walletService, 1);
    const b = await importWallet(rig.walletService, 2);
    const chain = fakePublicChain({});
    chain.seaDropReader.getPublicDrop = async () => {
      throw new TimeoutError({ body: {}, url: 'https://rpc.example/v2/SECRET' });
    };
    rig.chainServices.set(CHAIN_ID, chain);
    const mintExecutionService = new MintExecutionService(rig.walletService, rig.chainServices, rig.allowListStore, new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());
    const preview = new MintPreviewService(rig.walletService, rig.chainServices, mintExecutionService);

    const outcome = await preview.preview({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id, b.id], stage: 'public' });

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r) => r.eligible === 'unknown' && r.reason === 'rpc_unavailable')).toBe(true);
  });

  it('rejects a chain with no RPC configured', async () => {
    const rig = await buildRig(fakePublicChain({}));
    const a = await importWallet(rig.walletService, 1);
    const mintExecutionService = new MintExecutionService(rig.walletService, rig.chainServices, rig.allowListStore, new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());
    const preview = new MintPreviewService(rig.walletService, rig.chainServices, mintExecutionService);

    const outcome = await preview.preview({ ownerId: RESERVED_OPERATOR_USER_ID, nftContract: NFT_CONTRACT, chainId: 999_999, walletIds: [a.id], stage: 'public' });

    expect(outcome.preflightError).toBe('unsupported_chain');
  });
});

describe('MintPreviewService: allow-list stage (stored proof source, reusing the real verification path)', () => {
  it('reports eligible=true with the stage\'s own limit for a wallet ON the list, and eligible=false for one that is not', async () => {
    const rig = await buildRig(fakePublicChain({}));
    const onList = await importWallet(rig.walletService, 1);
    const notOnList = await importWallet(rig.walletService, 2);
    const entries: AllowListEntry[] = [{ minter: onList.address, mintParams: baseMintParams }];
    const tree = SeaDropAllowListTree.build(entries);

    const chain: ChainServices = {
      ...fakePublicChain({}),
      seaDropReader: { ...fakePublicChain({}).seaDropReader, async getAllowListMerkleRoot() { return tree.root; } } as never,
    };
    rig.chainServices.set(CHAIN_ID, chain);
    await rig.allowListStore.set('drop-1', entries);

    const mintExecutionService = new MintExecutionService(rig.walletService, rig.chainServices, rig.allowListStore, new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());
    const preview = new MintPreviewService(rig.walletService, rig.chainServices, mintExecutionService);

    const outcome = await preview.preview({
      ownerId: RESERVED_OPERATOR_USER_ID,
      nftContract: NFT_CONTRACT,
      chainId: CHAIN_ID,
      walletIds: [onList.id, notOnList.id],
      stage: 'allowlist',
      proofSource: 'stored',
      allowListId: 'drop-1',
    });

    const onListRow = rowFor(outcome.results, onList.id);
    expect(onListRow.eligible).toBe('eligible');
    expect(onListRow.limit).toBe(10);
    expect(onListRow.remaining).toBe(10);

    const notOnListRow = rowFor(outcome.results, notOnList.id);
    expect(notOnListRow.eligible).toBe('not_eligible');
    expect(notOnListRow.reason).toBe('not_eligible');
  });
});

describe('MintPreviewService, allow-list stage (OpenSea proof source): insufficient funds is "unknown", not a false "not eligible"', () => {
  it('distinguishes an unfunded wallet (unknown) from a genuinely ineligible one (not eligible)', async () => {
    const rig = await buildRig(fakePublicChain({}));
    const unfunded = await importWallet(rig.walletService, 1);
    const ineligible = await importWallet(rig.walletService, 2);

    // FakeOpenSeaDropClient supports one fixed behaviour, so this test drives it per wallet through a
    // small subclass.
    class PerWalletOpenSea extends FakeOpenSeaDropClient {
      override async fetchAllowListData(_slug: string, minter: `0x${string}`): Promise<never> {
        if (minter.toLowerCase() === unfunded.address) throw new OpenSeaDropError('insufficient_funds', 'Insufficient balance to mint');
        throw new OpenSeaDropError('not_eligible', 'Wallet exceeds allowed mint quantity');
      }
    }

    const mintExecutionService = new MintExecutionService(rig.walletService, rig.chainServices, rig.allowListStore, new PerWalletOpenSea(), makePermissiveSpendCapResolver());
    const preview = new MintPreviewService(rig.walletService, rig.chainServices, mintExecutionService);

    const outcome = await preview.preview({
      ownerId: RESERVED_OPERATOR_USER_ID,
      nftContract: NFT_CONTRACT,
      chainId: CHAIN_ID,
      walletIds: [unfunded.id, ineligible.id],
      stage: 'allowlist',
      proofSource: 'opensea',
      slug: 'facetsart',
    });

    const unfundedRow = rowFor(outcome.results, unfunded.id);
    expect(unfundedRow.eligible).toBe('unknown'); // NOT 'not_eligible': this is the bug the OpenSea 422 fix exists for
    expect(unfundedRow.reason).toBe('insufficient_funds');

    const ineligibleRow = rowFor(outcome.results, ineligible.id);
    expect(ineligibleRow.eligible).toBe('not_eligible');
  });
});
