import { describe, expect, it } from 'vitest';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { buildApp } from '../src/app.js';
import { BalanceService } from '../src/balance.service.js';
import { DisperseService } from '../src/disperse.service.js';
import { NftHoldingsService } from '../src/nft-holdings.service.js';
import { NftTransferService } from '../src/nft-transfer.service.js';
import { NftLedgerService } from '../src/nft-ledger.service.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { InProcessEventBus } from '@stryx/event-bus';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryNftLedgerRepository } from './fakes/in-memory-nft-ledger-repository.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';
import type { ChainServices } from '../src/chain-services.js';

const CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890';
const DESTINATION = '0x2222222222222222222222222222222222222222';

/**
 * `ownerOf` always resolves to `owner` when given (or throws, meaning "no chain configured" tests can
 * omit it entirely by never registering a chain at all).
 */
function makeChain(owner: string | null): ChainServices {
  return {
    seaDropReader: {} as never,
    publicClient: {
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'ownerOf') {
          if (!owner) throw new Error('no owner');
          return owner;
        }
        return 0n;
      },
    } as never,
    transactionEngine: {
      async executeTransaction() {
        return { hash: '0x' + '11'.repeat(32), nonce: 0, status: 'broadcast' };
      },
      async waitForConfirmation(hash: `0x${string}`, nonce: number) {
        return { hash, nonce, status: 'confirmed', receipt: { logs: [] } };
      },
    } as never,
  };
}

async function buildTestApp(opts: { withChain?: boolean; auditLog?: InMemoryAuditLogRepository } = {}) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const wallet = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

  const chainServices = new Map<number, ChainServices>(opts.withChain ? [[CHAIN_ID, makeChain(wallet.address)]] : []);
  const nftLedgerRepo = new InMemoryNftLedgerRepository();
  const nftLedgerService = new NftLedgerService(nftLedgerRepo);
  await nftLedgerService.recordMint({ walletId: wallet.id, ownerId: RESERVED_OPERATOR_USER_ID, chainId: CHAIN_ID, contract: CONTRACT, standard: 'erc721' }, [{ tokenId: '1', amount: '1' }]);

  const nftHoldingsService = new NftHoldingsService(walletService, nftLedgerService, new Map());
  const nftTransferService = new NftTransferService(walletService, chainServices, nftLedgerService);

  const app = buildApp({
    walletService,
    logger: noopLogger,
    chainServices,
    balanceService: new BalanceService(chainServices),
    disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()),
    nftHoldingsService,
    nftTransferService,
    ...(opts.auditLog ? { auditLogService: new AuditLogService(opts.auditLog, new InProcessEventBus(), noopLogger) } : {}),
  });

  return { app, walletId: wallet.id, walletAddress: wallet.address, nftLedgerRepo, nftTransferService };
}

describe('GET /wallets/:id/nfts', () => {
  it('returns the ledger-sourced holdings when no live indexer is configured', async () => {
    const { app, walletId } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: `/wallets/${walletId}/nfts?chainId=${CHAIN_ID}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('ledger');
    expect(body.holdings).toEqual([{ contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }]);
  });
});

describe('POST /wallets/nfts/transfer', () => {
  it('sends a real, still-owned item and returns 200 with the per-item outcome', async () => {
    const { app, walletId, nftLedgerRepo, nftTransferService } = await buildTestApp({ withChain: true });

    const res = await app.inject({
      method: 'POST',
      url: '/wallets/nfts/transfer',
      payload: {
        chainId: CHAIN_ID,
        destination: DESTINATION,
        items: [{ walletId, contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ status: 'sent' });
    // Marked once the chain confirms it, which is after the reply.
    await nftTransferService.idle();
    expect(nftLedgerRepo.rows[0]!.transferredAt).not.toBeNull();
  });

  it('returns 400 for a chain with no RPC configured', async () => {
    const { app, walletId } = await buildTestApp({ withChain: false });

    const res = await app.inject({
      method: 'POST',
      url: '/wallets/nfts/transfer',
      payload: {
        chainId: CHAIN_ID,
        destination: DESTINATION,
        items: [{ walletId, contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_chain');
  });

  it('rejects an empty item list at the schema level (zod .min(1)), before the service is ever called', async () => {
    const auditLog = new InMemoryAuditLogRepository();
    const { app } = await buildTestApp({ withChain: true, auditLog });

    const res = await app.inject({
      method: 'POST',
      url: '/wallets/nfts/transfer',
      payload: { chainId: CHAIN_ID, destination: DESTINATION, items: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    // Never reached the service, so nothing was audited: the schema rejected it first.
    expect(auditLog.entries).toHaveLength(0);
  });

  it('rejects a destination equal to a source wallet with 409', async () => {
    const { app, walletId, walletAddress } = await buildTestApp({ withChain: true });

    const res = await app.inject({
      method: 'POST',
      url: '/wallets/nfts/transfer',
      payload: {
        chainId: CHAIN_ID,
        destination: walletAddress,
        items: [{ walletId, contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('destination_is_source');
  });
});
