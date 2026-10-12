import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { InProcessEventBus } from '@stryx/event-bus';
import { noopLogger } from '@stryx/logger';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { buildApp } from '../src/app.js';
import { MintExecutionService } from '../src/mint-execution.service.js';
import { MintPreviewService } from '../src/mint-preview.service.js';
import { MintBatchService, MAX_BATCH_WALLETS } from '../src/mint-batch.service.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { FakeOpenSeaDropClient } from './fakes/fake-opensea-drop-client.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';
import type { ChainServices } from '../src/chain-services.js';

const CHAIN_ID = 46630;
const NFT_CONTRACT = '0x1234567890123456789012345678901234567890';

function fakeChain(behaviorByAddress: Record<string, { hash: string } | Error> = {}): ChainServices {
  return {
    seaDropReader: {
      async getPublicDrop() {
        return { mintPrice: 0n, startTime: 1_700_000_000, endTime: 2_000_000_000, maxTotalMintableByWallet: 10, feeBps: 0, restrictFeeRecipients: false };
      },
      async isPublicStageActive() {
        return true;
      },
      async getAllowedFeeRecipients() {
        return ['0x0000a26b00c1F0DF003000390027140000fAa719'];
      },
      async getMintStats(_scope: unknown, _minter: `0x${string}`) {
        return { minterNumMinted: 0, currentTotalSupply: 0n, maxSupply: 1000n };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    transactionEngine: {
      async executeTransaction(scope: { walletAddress: string }) {
        const behavior = behaviorByAddress[scope.walletAddress.toLowerCase()];
        if (behavior instanceof Error) throw behavior;
        return { hash: behavior?.hash ?? '0x' + '11'.repeat(32), nonce: 0, status: 'broadcast' };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    publicClient: {
      async getBalance() {
        return 1_000_000_000_000_000_000n;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

async function buildRig(chain: ChainServices) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
  const allowListStore = new InMemoryAllowListStore();
  const mintExecutionService = new MintExecutionService(walletService, chainServices, allowListStore, new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());
  const mintPreviewService = new MintPreviewService(walletService, chainServices, mintExecutionService);
  const mintBatchService = new MintBatchService(walletService, chainServices, mintExecutionService);
  const auditLogRepository = new InMemoryAuditLogRepository();
  const auditLogService = new AuditLogService(auditLogRepository, new InProcessEventBus(), noopLogger);

  const app = buildApp({ walletService, logger: noopLogger, mintExecutionService, mintPreviewService, mintBatchService, chainServices, auditLogService });

  async function importWallet(keyByte: number) {
    const privateKey = ('0x' + String(keyByte).padStart(2, '0').repeat(32)) as `0x${string}`;
    const address = privateKeyToAccount(privateKey).address;
    const wallet = await walletService.importWallet({ privateKey, tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);
    return { id: wallet.id, address: address.toLowerCase() };
  }

  /**
   * Swaps the chain services this app reads from: the Map reference is shared, so the change is
   * visible to the app already built.
   */
  function setChain(next: ChainServices) {
    chainServices.set(CHAIN_ID, next);
  }

  return { app, importWallet, setChain, auditLogRepository };
}

describe('POST /mints/seadrop/preview', () => {
  it('returns one row per wallet', async () => {
    const rig = await buildRig(fakeChain());
    const a = await rig.importWallet(1);

    const res = await rig.app.inject({
      method: 'POST',
      url: '/mints/seadrop/preview',
      payload: { nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id], stage: 'public' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
    expect(res.json().results[0].eligible).toBe('eligible');
  });

  it('rejects an unsupported chain with 400', async () => {
    const rig = await buildRig(fakeChain());
    const a = await rig.importWallet(1);

    const res = await rig.app.inject({
      method: 'POST',
      url: '/mints/seadrop/preview',
      payload: { nftContract: NFT_CONTRACT, chainId: 999_999, walletIds: [a.id], stage: 'public' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_chain');
  });

  it('rejects a request with no wallets (schema validation, before ever reaching the service)', async () => {
    const rig = await buildRig(fakeChain());

    const res = await rig.app.inject({
      method: 'POST',
      url: '/mints/seadrop/preview',
      payload: { nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [], stage: 'public' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /mints/seadrop/batch', () => {
  it('mints every wallet and records one audit entry per wallet, using the same mint.public action a single mint would', async () => {
    const rig = await buildRig(fakeChain());
    const a = await rig.importWallet(1);
    const b = await rig.importWallet(2);

    const res = await rig.app.inject({
      method: 'POST',
      url: '/mints/seadrop/batch',
      payload: { nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id, b.id], quantity: 1, stage: 'public' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(2);

    const mintEntries = rig.auditLogRepository.entries.filter((e) => e.action === 'mint.public');
    expect(mintEntries).toHaveLength(2);
    expect(mintEntries.every((e) => e.outcome === 'success')).toBe(true);
    expect(new Set(mintEntries.map((e) => e.walletId))).toEqual(new Set([a.id, b.id]));
  });

  it('a partial failure still returns 200 with per-wallet detail, and logs the failed wallet\'s audit entry as a failure', async () => {
    const rig = await buildRig(fakeChain());
    const a = await rig.importWallet(1);
    const b = await rig.importWallet(2);
    const { SimulationRevertedError } = await import('@stryx/transaction-engine');
    rig.setChain(
      fakeChain({
        [b.address]: new SimulationRevertedError({ chainId: CHAIN_ID, walletId: b.id, walletAddress: b.address, ownerId: RESERVED_OPERATOR_USER_ID, spendCapWei: null }, new Error('reverted')),
      }),
    );

    const res = await rig.app.inject({
      method: 'POST',
      url: '/mints/seadrop/batch',
      payload: { nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id, b.id], quantity: 1, stage: 'public' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.results.find((r: { walletId: string }) => r.walletId === b.id).status).toBe('failed');

    const failedEntry = rig.auditLogRepository.entries.find((e) => e.walletId === b.id);
    expect(failedEntry?.outcome).toBe('failure');
  });

  it(`refuses more than ${MAX_BATCH_WALLETS} wallets with 413, before touching any wallet`, async () => {
    const rig = await buildRig(fakeChain());
    const ids = Array.from({ length: MAX_BATCH_WALLETS + 1 }, (_, i) => `wallet-${i}`);

    const res = await rig.app.inject({
      method: 'POST',
      url: '/mints/seadrop/batch',
      payload: { nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: ids, quantity: 1, stage: 'public' },
    });

    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too_many_wallets');
  });

  it('rejects the same wallet id twice with 400', async () => {
    const rig = await buildRig(fakeChain());
    const a = await rig.importWallet(1);

    const res = await rig.app.inject({
      method: 'POST',
      url: '/mints/seadrop/batch',
      payload: { nftContract: NFT_CONTRACT, chainId: CHAIN_ID, walletIds: [a.id, a.id], quantity: 1, stage: 'public' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('duplicate_wallets');
  });
});
