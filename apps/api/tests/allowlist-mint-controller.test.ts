import { describe, expect, it } from 'vitest';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import type { FastifyInstance } from 'fastify';
import { getAddress, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { SeaDropAllowListTree, type AllowListEntry } from '@stryx/eligibility';
import { buildApp } from '../src/app.js';
import { MintExecutionService } from '../src/mint-execution.service.js';
import type { ChainServices } from '../src/chain-services.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import { FakeOpenSeaDropClient } from './fakes/fake-opensea-drop-client.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';

const TEST_CHAIN_ID = 46630;
const NFT_CONTRACT = '0x1234567890123456789012345678901234567890';

const baseMintParams = {
  mintPrice: parseEther('0'),
  maxTotalMintableByWallet: 10,
  startTime: 1_700_000_000,
  endTime: 2_000_000_000,
  dropStageIndex: 1,
  maxTokenSupplyForStage: 1000n,
  feeBps: 0,
  restrictFeeRecipients: false,
};

function fakeSeaDropReader(merkleRoot: `0x${string}`, feeRecipients: readonly `0x${string}`[] = ['0x0000a26b00c1F0DF003000390027140000fAa719']) {
  return {
    async getAllowListMerkleRoot() {
      return merkleRoot;
    },
    async getAllowedFeeRecipients() {
      return feeRecipients;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeTransactionEngine() {
  return {
    async executeTransaction() {
      return { hash: '0x' + '11'.repeat(32), nonce: 0, status: 'broadcast' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Builds an app where the wallet under test is on the allow-list and the fake reader reports the
 * tree's real root, so the full verification path runs.
 */
async function buildRig(opts: { onChainRootOverride?: `0x${string}` } = {}) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);

  // Import a wallet with a known key so we know its address for the allow-list.
  const privateKey = ('0x' + '11'.repeat(32)) as `0x${string}`;
  const walletAddress = privateKeyToAccount(privateKey).address;
  const imported = await walletService.importWallet({ privateKey, tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

  // Build a real allow-list tree containing that wallet.
  const otherAddr = getAddress('0x' + '22'.repeat(20));
  const entries: AllowListEntry[] = [
    { minter: walletAddress, mintParams: baseMintParams },
    { minter: otherAddr, mintParams: baseMintParams },
  ];
  const tree = SeaDropAllowListTree.build(entries);

  const onChainRoot = opts.onChainRootOverride ?? tree.root;

  const allowListStore = new InMemoryAllowListStore();
  await allowListStore.set('drop-1', entries);

  const chainServices = new Map<number, ChainServices>();
  chainServices.set(TEST_CHAIN_ID, {
    seaDropReader: fakeSeaDropReader(onChainRoot),
    transactionEngine: fakeTransactionEngine(),
      publicClient: {} as never,
  });

  const mintExecutionService = new MintExecutionService(walletService, chainServices, allowListStore, new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());
  const app: FastifyInstance = buildApp({
    walletService,
    logger: noopLogger,
    mintExecutionService,
  });

  // Compute the direct-path proof for this wallet from the same tree.
  const proofResult = tree.getProofForMinter(walletAddress);

  return { app, walletId: imported.id, walletAddress, tree, proofResult };
}

function mintParamsToJson(p: typeof baseMintParams) {
  return {
    mintPrice: p.mintPrice.toString(),
    maxTotalMintableByWallet: p.maxTotalMintableByWallet,
    startTime: p.startTime,
    endTime: p.endTime,
    dropStageIndex: p.dropStageIndex,
    maxTokenSupplyForStage: p.maxTokenSupplyForStage.toString(),
    feeBps: p.feeBps,
    restrictFeeRecipients: p.restrictFeeRecipients,
  };
}

describe('allow-list mint controller', () => {
  it('Path A (direct): mints when a valid proof + mintParams are supplied and match the on-chain root', async () => {
    const { app, walletId, proofResult } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: {
        walletId,
        nftContract: NFT_CONTRACT,
        chainId: TEST_CHAIN_ID,
        quantity: 1,
        proofSource: 'direct',
        mintParams: mintParamsToJson(baseMintParams),
        proof: proofResult!.proof,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('broadcast');
  });

  it('Path B (stored): mints when the wallet is found in the stored allow-list', async () => {
    const { app, walletId } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: {
        walletId,
        nftContract: NFT_CONTRACT,
        chainId: TEST_CHAIN_ID,
        quantity: 1,
        proofSource: 'stored',
        allowListId: 'drop-1',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('broadcast');
  });

  it('Path A: rejects with 403 not_eligible when the proof does not verify against the on-chain root', async () => {
    const { app, walletId } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: {
        walletId,
        nftContract: NFT_CONTRACT,
        chainId: TEST_CHAIN_ID,
        quantity: 1,
        proofSource: 'direct',
        mintParams: mintParamsToJson(baseMintParams),
        proof: [('0x' + 'de'.repeat(32))], // garbage proof
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('not_eligible');
  });

  it('Path B: rejects with 403 root_mismatch when the stored list root differs from the on-chain root', async () => {
    const { app, walletId } = await buildRig({ onChainRootOverride: ('0x' + 'ff'.repeat(32)) as `0x${string}` });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: {
        walletId,
        nftContract: NFT_CONTRACT,
        chainId: TEST_CHAIN_ID,
        quantity: 1,
        proofSource: 'stored',
        allowListId: 'drop-1',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().reason).toBe('root_mismatch');
  });

  it('Path B: 404 when the referenced allow-list does not exist', async () => {
    const { app, walletId } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: {
        walletId,
        nftContract: NFT_CONTRACT,
        chainId: TEST_CHAIN_ID,
        quantity: 1,
        proofSource: 'stored',
        allowListId: 'does-not-exist',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('allowlist_not_found');
  });

  it('returns 400 for an unconfigured chain', async () => {
    const { app, walletId, proofResult } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: {
        walletId,
        nftContract: NFT_CONTRACT,
        chainId: 999999,
        quantity: 1,
        proofSource: 'direct',
        mintParams: mintParamsToJson(baseMintParams),
        proof: proofResult!.proof,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('unsupported_chain');
  });

  it('rejects a malformed body (missing proofSource discriminator) with 400', async () => {
    const { app, walletId } = await buildRig();

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: { walletId, nftContract: NFT_CONTRACT, chainId: TEST_CHAIN_ID, quantity: 1 },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('allow-list mint controller: opensea proof source', () => {
  it('mints when OpenSea returns a proof that verifies against the on-chain root', async () => {
    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);
    const walletService = new WalletService(repository, walletKeyService, kms.keyId);

    const privateKey = ('0x' + '33'.repeat(32)) as `0x${string}`;
    const walletAddress = privateKeyToAccount(privateKey).address;
    const imported = await walletService.importWallet({ privateKey, tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

    // Real tree containing the wallet; OpenSea will "return" this wallet's real proof.
    const entries: AllowListEntry[] = [
      { minter: walletAddress, mintParams: baseMintParams },
      { minter: getAddress('0x' + '44'.repeat(20)), mintParams: baseMintParams },
    ];
    const tree = SeaDropAllowListTree.build(entries);
    const proofResult = tree.getProofForMinter(walletAddress)!;

    const chainServices = new Map<number, ChainServices>();
    chainServices.set(TEST_CHAIN_ID, {
      seaDropReader: fakeSeaDropReader(tree.root),
      transactionEngine: fakeTransactionEngine(),
      publicClient: {} as never,
    });

    const openSeaClient = new FakeOpenSeaDropClient({
      kind: 'success',
      data: { mintParams: proofResult.mintParams, proof: proofResult.proof },
    });
    const mintExecutionService = new MintExecutionService(walletService, chainServices, new InMemoryAllowListStore(), openSeaClient, makePermissiveSpendCapResolver());
    const app = buildApp({ walletService, logger: noopLogger, mintExecutionService });

    const res = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: { proofSource: 'opensea', walletId: imported.id, nftContract: NFT_CONTRACT, chainId: TEST_CHAIN_ID, quantity: 1, slug: 'some-drop' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('broadcast');
  });

  it('rejects with 403 when OpenSea returns a proof that does NOT verify against the on-chain root', async () => {
    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);
    const walletService = new WalletService(repository, walletKeyService, kms.keyId);

    const privateKey = ('0x' + '55'.repeat(32)) as `0x${string}`;
    const walletAddress = privateKeyToAccount(privateKey).address;
    const imported = await walletService.importWallet({ privateKey, tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

    const entries: AllowListEntry[] = [{ minter: walletAddress, mintParams: baseMintParams }];
    const tree = SeaDropAllowListTree.build(entries);

    const chainServices = new Map<number, ChainServices>();
    chainServices.set(TEST_CHAIN_ID, {
      seaDropReader: fakeSeaDropReader(tree.root),
      transactionEngine: fakeTransactionEngine(),
      publicClient: {} as never,
    });

    // OpenSea returns a garbage proof: the on-chain verification must catch it.
    const openSeaClient = new FakeOpenSeaDropClient({
      kind: 'success',
      data: { mintParams: baseMintParams, proof: [('0x' + 'de'.repeat(32)) as `0x${string}`] },
    });
    const mintExecutionService = new MintExecutionService(walletService, chainServices, new InMemoryAllowListStore(), openSeaClient, makePermissiveSpendCapResolver());
    const app = buildApp({ walletService, logger: noopLogger, mintExecutionService });

    const res = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: { proofSource: 'opensea', walletId: imported.id, nftContract: NFT_CONTRACT, chainId: TEST_CHAIN_ID, quantity: 1, slug: 'some-drop' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_eligible');
  });

  it('returns 502 when the OpenSea fetch itself fails', async () => {
    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);
    const walletService = new WalletService(repository, walletKeyService, kms.keyId);
    const imported = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

    const chainServices = new Map<number, ChainServices>();
    chainServices.set(TEST_CHAIN_ID, {
      seaDropReader: fakeSeaDropReader(('0x' + '00'.repeat(32)) as `0x${string}`),
      transactionEngine: fakeTransactionEngine(),
      publicClient: {} as never,
    });

    const { OpenSeaDropError } = await import('../src/opensea-drop-client.js');
    const openSeaClient = new FakeOpenSeaDropClient({
      kind: 'throw',
      error: new OpenSeaDropError('not_found', 'no such drop'),
    });
    const mintExecutionService = new MintExecutionService(walletService, chainServices, new InMemoryAllowListStore(), openSeaClient, makePermissiveSpendCapResolver());
    const app = buildApp({ walletService, logger: noopLogger, mintExecutionService });

    const res = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/allowlist',
      payload: { proofSource: 'opensea', walletId: imported.id, nftContract: NFT_CONTRACT, chainId: TEST_CHAIN_ID, quantity: 1, slug: 'missing' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('opensea_fetch_failed');
  });
});
