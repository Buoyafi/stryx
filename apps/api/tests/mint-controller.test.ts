import { describe, expect, it } from 'vitest';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import {
  EmergencyStopActiveError,
  SimulationRevertedError,
  SpendingCapExceededError,
  RpcUnavailableError,
} from '@stryx/transaction-engine';
import { DecryptionIntegrityError } from '@stryx/key-management';
import { CallExecutionError, RawContractError, TimeoutError, encodeErrorResult, RpcRequestError, InvalidInputRpcError, InsufficientFundsError, TransactionRejectedRpcError } from 'viem';
import { buildApp } from '../src/app.js';
import { MintExecutionService } from '../src/mint-execution.service.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import { FakeOpenSeaDropClient } from './fakes/fake-opensea-drop-client.js';
import type { ChainServices } from '../src/chain-services.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';
import { InProcessEventBus } from '@stryx/event-bus';
import { AuditLogService } from '../src/audit-log-service.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';

const TEST_CHAIN_ID = 46630; // Robinhood Chain testnet
const scope = { nftContract: '0x1234567890123456789012345678901234567890', chainId: TEST_CHAIN_ID };

function fakeSeaDropReader(opts: {
  isActive?: boolean;
  mintPrice?: bigint;
  feeRecipients?: readonly `0x${string}`[];
}) {
  return {
    async getPublicDrop() {
      return {
        mintPrice: opts.mintPrice ?? 10_000_000_000_000n,
        startTime: 1,
        endTime: 9_999_999_999,
        maxTotalMintableByWallet: 5,
        feeBps: 500,
        restrictFeeRecipients: false,
      };
    },
    async isPublicStageActive() {
      return opts.isActive ?? true;
    },
    async getAllowedFeeRecipients() {
      return opts.feeRecipients ?? ['0x0000a26b00c1f0df003000390027140000faa719'];
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeTransactionEngine(opts: { throws?: Error; result?: { hash: string; nonce: number; status: string } }) {
  return {
    async executeTransaction() {
      if (opts.throws) throw opts.throws;
      return opts.result ?? { hash: '0x' + '11'.repeat(32), nonce: 0, status: 'broadcast' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function buildTestAppWithMint(chainOverrides: {
  seaDropReader?: ReturnType<typeof fakeSeaDropReader>;
  transactionEngine?: ReturnType<typeof fakeTransactionEngine>;
  omitChain?: boolean;
  auditLogRepository?: InMemoryAuditLogRepository;
}): Promise<{ app: FastifyInstance; walletId: string }> {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);

  const created = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

  const chainServices = new Map<number, ChainServices>();
  if (!chainOverrides.omitChain) {
    chainServices.set(TEST_CHAIN_ID, {
      seaDropReader: chainOverrides.seaDropReader ?? fakeSeaDropReader({}),
      transactionEngine: chainOverrides.transactionEngine ?? fakeTransactionEngine({}),
      publicClient: {} as never,
    });
  }

  const mintExecutionService = new MintExecutionService(
    walletService,
    chainServices,
    new InMemoryAllowListStore(),
    new FakeOpenSeaDropClient(),
    makePermissiveSpendCapResolver(),
  );
  const auditLogService = chainOverrides.auditLogRepository
    ? new AuditLogService(chainOverrides.auditLogRepository, new InProcessEventBus(), noopLogger)
    : undefined;
  const app = buildApp({
    walletService,
    logger: noopLogger,
    mintExecutionService,
    ...(auditLogService ? { auditLogService } : {}),
  });

  return { app, walletId: created.id };
}

describe('mint controller', () => {
  it('executes a public-stage mint and returns the broadcast result', async () => {
    const { app, walletId } = await buildTestAppWithMint({});

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('broadcast');
    expect(body.hash).toBeDefined();
  });

  it('returns 400 for a chainId with no RPC configured on this instance', async () => {
    const { app, walletId } = await buildTestAppWithMint({ omitChain: true });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('unsupported_chain');
  });

  it('returns 409 when there is no active public stage', async () => {
    const { app, walletId } = await buildTestAppWithMint({
      seaDropReader: fakeSeaDropReader({ isActive: false }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('no_active_public_stage');
  });

  it('returns 409 when no fee recipient is configured', async () => {
    const { app, walletId } = await buildTestAppWithMint({
      seaDropReader: fakeSeaDropReader({ feeRecipients: [] }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('no_fee_recipient_configured');
  });

  it('maps EmergencyStopActiveError to 423', async () => {
    const stopError = new EmergencyStopActiveError(
      { chainId: TEST_CHAIN_ID, walletId: 'w', walletAddress: '0x0000000000000000000000000000000000dead', ownerId: 'owner-1', spendCapWei: null },
      'pre-sign',
    );
    const { app, walletId } = await buildTestAppWithMint({
      transactionEngine: fakeTransactionEngine({ throws: stopError }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(423);
    expect(response.json().error).toBe('emergency_stop_active');
  });

  it('maps SpendingCapExceededError to 429 (ADR-002 §3.7)', async () => {
    const capError = new SpendingCapExceededError(
      { chainId: TEST_CHAIN_ID, walletId: 'w', walletAddress: '0x0000000000000000000000000000000000dead', ownerId: 'owner-1', spendCapWei: 1000n },
      1000n,
      1500n,
    );
    const { app, walletId } = await buildTestAppWithMint({
      transactionEngine: fakeTransactionEngine({ throws: capError }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error).toBe('spending_cap_exceeded');
  });

  it('maps RpcUnavailableError (from the transaction engine) to 502, distinct from a genuine revert', async () => {
    const rpcError = new RpcUnavailableError(
      { chainId: TEST_CHAIN_ID, walletId: 'w', walletAddress: '0x0000000000000000000000000000000000dead', ownerId: 'owner-1', spendCapWei: null },
      'gas-estimation',
      new Error('simulated RPC timeout'),
    );
    const { app, walletId } = await buildTestAppWithMint({
      transactionEngine: fakeTransactionEngine({ throws: rpcError }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('rpc_unavailable');
    expect(response.json().stage).toBe('gas-estimation');
  });

  it('maps an unreachable RPC during the SeaDrop chain reads (before the transaction engine is even involved) to 502, not a generic 500', async () => {
    const unreachableSeaDropReader = {
      async getPublicDrop() {
        throw new TimeoutError({ body: {}, url: 'http://rpc.example' });
      },
      async isPublicStageActive() {
        return true;
      },
      async getAllowedFeeRecipients() {
        return ['0x0000a26b00c1f0df003000390027140000faa719'];
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const { app, walletId } = await buildTestAppWithMint({ seaDropReader: unreachableSeaDropReader });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('rpc_unavailable');
  });

  it('resolves the caller\'s spend cap and threads it (plus ownerId) into the transaction scope actually executed', async () => {
    let capturedScope: { ownerId?: string; spendCapWei?: bigint | null } | undefined;
    const capturingEngine = {
      async executeTransaction(scope: { ownerId?: string; spendCapWei?: bigint | null }) {
        capturedScope = scope;
        return { hash: '0x' + '11'.repeat(32), nonce: 0, status: 'broadcast' };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const { app, walletId } = await buildTestAppWithMint({ transactionEngine: capturingEngine });

    await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(capturedScope?.ownerId).toBe(RESERVED_OPERATOR_USER_ID);
    // The test app uses an effectively unlimited cap resolver: this proves the resolver's value is
    // what lands in the scope.
    expect(capturedScope?.spendCapWei).toBe(2n ** 128n);
  });

  it('maps SimulationRevertedError to 422', async () => {
    const revertError = new SimulationRevertedError(
      { chainId: TEST_CHAIN_ID, walletId: 'w', walletAddress: '0x0000000000000000000000000000000000dead', ownerId: 'owner-1', spendCapWei: null },
      new Error('sold out'),
    );
    const { app, walletId } = await buildTestAppWithMint({
      transactionEngine: fakeTransactionEngine({ throws: revertError }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('simulation_reverted');
  });

  it('maps a raw viem InsufficientFundsError thrown straight from the transaction engine (not wrapped in RpcUnavailableError or SimulationRevertedError) to a clean, short 402, not a raw multi-paragraph dump (this happens when a wallet passes gas estimation/simulation but the real broadcast rejects it for having no funds)', async () => {
    const rpcErr = new RpcRequestError({
      body: {},
      url: 'http://rpc.example',
      error: { code: -32000, message: 'err: insufficient funds for gas * price + value: address 0x0 have 0 want 1701084000000' },
    });
    const invalidInput = new InvalidInputRpcError(rpcErr);
    const insufficientFunds = new InsufficientFundsError({ cause: invalidInput });
    const { app, walletId } = await buildTestAppWithMint({
      transactionEngine: fakeTransactionEngine({ throws: insufficientFunds }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({ error: 'insufficient_funds', message: 'Insufficient funds for gas.' });
  });

  it('maps a pre-send check refused for lack of funds ("OutOfFunds", a wording viem has no class for) to 402, not simulation_reverted', async () => {
    const rpcErr = new RpcRequestError({ body: {}, url: 'http://rpc.example', error: { code: -32003, message: 'EVM error: OutOfFunds' } });
    const callError = new CallExecutionError(new TransactionRejectedRpcError(rpcErr), { to: scope.nftContract as `0x${string}` });
    const revertError = new SimulationRevertedError(
      { chainId: TEST_CHAIN_ID, walletId: 'w', walletAddress: '0x0000000000000000000000000000000000dead', ownerId: 'owner-1', spendCapWei: null },
      callError,
    );
    const { app, walletId } = await buildTestAppWithMint({
      transactionEngine: fakeTransactionEngine({ throws: revertError }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({ error: 'insufficient_funds', message: 'Not enough funds for the mint price.' });
  });

  it('decodes a SeaDrop revert into its real reason instead of "unknown reason"', async () => {
    const data = encodeErrorResult({
      abi: [
        {
          type: 'error',
          name: 'IncorrectPayment',
          inputs: [
            { name: 'got', type: 'uint256' },
            { name: 'want', type: 'uint256' },
          ],
        },
      ],
      errorName: 'IncorrectPayment',
      args: [1n, 2n],
    });
    const raw = new RawContractError({ data, message: 'execution reverted' });
    const callError = new CallExecutionError(raw, { to: scope.nftContract as `0x${string}` });
    const revertError = new SimulationRevertedError(
      { chainId: TEST_CHAIN_ID, walletId: 'w', walletAddress: '0x0000000000000000000000000000000000dead', ownerId: 'owner-1', spendCapWei: null },
      callError,
    );
    const { app, walletId } = await buildTestAppWithMint({
      transactionEngine: fakeTransactionEngine({ throws: revertError }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().message).toBe('IncorrectPayment(1, 2)');
  });

  it('maps a wallet key decryption failure to a 422, not a generic 500', async () => {
    const decryptError = new DecryptionIntegrityError({ walletId: 'w' });
    const { app, walletId } = await buildTestAppWithMint({
      transactionEngine: fakeTransactionEngine({ throws: decryptError }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('wallet_key_unavailable');
  });

  it('rejects an invalid request body with a validation error', async () => {
    const { app, walletId } = await buildTestAppWithMint({});

    const response = await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: 'not-an-address', chainId: scope.chainId, quantity: 1 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('records an audit entry for a successful mint, and a separate one for a failed one (ADR-002 §3.10)', async () => {
    const auditLogRepository = new InMemoryAuditLogRepository();
    const { app, walletId } = await buildTestAppWithMint({ auditLogRepository });

    await app.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(auditLogRepository.entries).toHaveLength(1);
    expect(auditLogRepository.entries[0]).toMatchObject({
      actorUserId: RESERVED_OPERATOR_USER_ID,
      action: 'mint.public',
      walletId,
      outcome: 'success',
    });

    // A second, failing mint: a separate entry, not overwriting the first.
    const { app: failingApp, walletId: failingWalletId } = await buildTestAppWithMint({
      seaDropReader: fakeSeaDropReader({ isActive: false }),
      auditLogRepository,
    });
    await failingApp.inject({
      method: 'POST',
      url: '/mints/seadrop/public',
      payload: { walletId: failingWalletId, nftContract: scope.nftContract, chainId: scope.chainId, quantity: 1 },
    });

    expect(auditLogRepository.entries).toHaveLength(2);
    expect(auditLogRepository.entries[1]).toMatchObject({ action: 'mint.public', outcome: 'failure' });
  });
});
