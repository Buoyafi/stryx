import { describe, expect, it } from 'vitest';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { parseEther, InvalidParamsRpcError, RpcRequestError, TransactionNotFoundError, TransactionReceiptNotFoundError, TimeoutError } from 'viem';
import { EmergencyStopActiveError, SpendingCapExceededError, RpcUnavailableError } from '@stryx/transaction-engine';
import { BalanceService } from '../src/balance.service.js';
import { DisperseService } from '../src/disperse.service.js';
import type { ChainServices } from '../src/chain-services.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';

const CHAIN_ID = 46630;
const SOURCE = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const R1 = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const R2 = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const R3 = '0x4444444444444444444444444444444444444444' as `0x${string}`;

function makeChain(opts: {
  balance?: bigint;
  /** Addresses that should fail when sent to. */
  failFor?: Set<string>;
  /** Throw an emergency stop when sending to this address. */
  emergencyStopAt?: string;
  /** Throw SpendingCapExceededError when sending to this address (ADR-002 §3.7). */
  spendingCapExceededAt?: string;
  /** Throw RpcUnavailableError when sending to this address. */
  rpcUnavailableAt?: string;
  balanceThrows?: boolean;
  /** What the chain says one transfer costs in gas. Left out: the chain will not estimate. */
  gasPerTransfer?: bigint;
  /** Called by the disperse pre-flight's nonce health check. */
  warmNonce?: (scope: { chainId: number; walletAddress: string }) => Promise<void>;
}): ChainServices {
  let nonce = 0;
  return {
    seaDropReader: {} as never,
    publicClient: {
      async getBalance() {
        if (opts.balanceThrows) throw new Error('rpc down');
        return opts.balance ?? parseEther('10');
      },
      async estimateFeesPerGas() {
        return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
      },
      async estimateGas() {
        if (opts.gasPerTransfer === undefined) throw new Error('estimate not supported');
        return opts.gasPerTransfer;
      },
    } as never,
    transactionEngine: {
      async warmNonce(scope: { chainId: number; walletAddress: string }) {
        await opts.warmNonce?.(scope);
      },
      async executeTransaction(_scope: unknown, tx: { to: string; value: bigint }) {
        if (opts.emergencyStopAt === tx.to) {
          throw new EmergencyStopActiveError(
            { chainId: CHAIN_ID, walletId: 'w', walletAddress: SOURCE, ownerId: 'owner-1', spendCapWei: null },
            'pre-sign',
          );
        }
        if (opts.spendingCapExceededAt === tx.to) {
          throw new SpendingCapExceededError(
            { chainId: CHAIN_ID, walletId: 'w', walletAddress: SOURCE, ownerId: 'owner-1', spendCapWei: parseEther('0.02') },
            parseEther('0.02'),
            parseEther('0.02') + tx.value,
          );
        }
        if (opts.rpcUnavailableAt === tx.to) {
          throw new RpcUnavailableError(
            { chainId: CHAIN_ID, walletId: 'w', walletAddress: SOURCE, ownerId: 'owner-1', spendCapWei: null },
            'pre-simulation',
            new Error('simulated RPC timeout'),
          );
        }
        if (opts.failFor?.has(tx.to)) throw new Error('broadcast failed');
        return { hash: `0xhash${nonce}`, nonce: nonce++, status: 'broadcast' };
      },
    } as never,
  };
}

function makeWalletService() {
  return {
    async getWalletSummary() {
      return { id: 'w1', address: SOURCE };
    },
  } as never;
}

describe('bulk balances route', () => {
  it('routes /wallets/balances as a static path, not as /wallets/:id with id="balances"', async () => {
    // Fastify prefers static routes over parametric ones; this pins that down.
    const { buildApp } = await import('../src/app.js');
    const { WalletKeyService, LocalKeyManagementProvider } = await import('@stryx/key-management');
    const { WalletService } = await import('@stryx/wallet-service');
    const { noopLogger } = await import('@stryx/logger');
    const { InMemoryWalletRepository } = await import('./fakes/in-memory-wallet.repository.js');

    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
    await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

    const chainServices = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ balance: parseEther('2') })]]);
    const app = buildApp({
      walletService,
      logger: noopLogger,
      chainServices,
      balanceService: new BalanceService(chainServices),
      disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()),
    });

    const res = await app.inject({ method: 'GET', url: `/wallets/balances?chainId=${CHAIN_ID}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chainId).toBe(CHAIN_ID);
    expect(body.balances).toHaveLength(1);
    expect(body.balances[0].formatted).toBe('2');
  });

  it('returns 400 for a chain with no RPC configured', async () => {
    const { buildApp } = await import('../src/app.js');
    const { WalletKeyService, LocalKeyManagementProvider } = await import('@stryx/key-management');
    const { WalletService } = await import('@stryx/wallet-service');
    const { noopLogger } = await import('@stryx/logger');
    const { InMemoryWalletRepository } = await import('./fakes/in-memory-wallet.repository.js');

    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
    const chainServices = new Map<number, ChainServices>();
    const app = buildApp({
      walletService,
      logger: noopLogger,
      chainServices,
      balanceService: new BalanceService(chainServices),
      disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()),
    });

    const res = await app.inject({ method: 'GET', url: '/wallets/balances?chainId=999999' });
    expect(res.statusCode).toBe(400);
  });

  it('bounds concurrency across wallets, rather than firing every wallet\'s chain read at once (many wallets * every configured chain hit a real provider\'s per-origin connection ceiling, requests past it silently queued and several never got a turn within the read timeout)', async () => {
    const { buildApp } = await import('../src/app.js');
    const { WalletKeyService, LocalKeyManagementProvider } = await import('@stryx/key-management');
    const { WalletService } = await import('@stryx/wallet-service');
    const { noopLogger } = await import('@stryx/logger');
    const { InMemoryWalletRepository } = await import('./fakes/in-memory-wallet.repository.js');

    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
    await Promise.all(Array.from({ length: 12 }, () => walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID)));

    let inFlight = 0;
    let peak = 0;
    const chain = {
      seaDropReader: {} as never,
      publicClient: {
        async getBalance() {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          return parseEther('1');
        },
      } as never,
      transactionEngine: {} as never,
    };
    const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
    const app = buildApp({
      walletService,
      logger: noopLogger,
      chainServices,
      balanceService: new BalanceService(chainServices),
      disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()),
    });

    const res = await app.inject({ method: 'GET', url: `/wallets/balances?chainId=${CHAIN_ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().balances).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(5); // BALANCE_BATCH_POOL_SIZE, never all 12 wallets at once
    expect(peak).toBeGreaterThan(1); // still genuinely concurrent, not accidentally serialized
  });
});

describe('bulk balances route reads only the requested chain', () => {
  it('a slow or broken OTHER chain never delays or fails this chain\'s list', async () => {
    const { buildApp } = await import('../src/app.js');
    const { WalletKeyService, LocalKeyManagementProvider } = await import('@stryx/key-management');
    const { WalletService } = await import('@stryx/wallet-service');
    const { noopLogger } = await import('@stryx/logger');
    const { InMemoryWalletRepository } = await import('./fakes/in-memory-wallet.repository.js');

    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
    await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

    let otherChainReads = 0;
    const brokenOther = {
      seaDropReader: {} as never,
      transactionEngine: {} as never,
      publicClient: {
        async getBalance() {
          otherChainReads++;
          throw new Error('HTTP request failed. URL: https://eth-mainnet.example/v2/SECRETKEY Details: timed out');
        },
      } as never,
    };
    const chainServices = new Map<number, ChainServices>([
      [CHAIN_ID, makeChain({ balance: parseEther('2') })],
      [1, brokenOther],
    ]);
    const app = buildApp({
      walletService,
      logger: noopLogger,
      chainServices,
      balanceService: new BalanceService(chainServices),
      disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()),
    });

    const res = await app.inject({ method: 'GET', url: `/wallets/balances?chainId=${CHAIN_ID}` });
    expect(res.json().balances[0]).toMatchObject({ formatted: '2' });
    expect(res.json().balances[0].error).toBeUndefined();
    expect(otherChainReads).toBe(0);

    const eth = await app.inject({ method: 'GET', url: '/wallets/balances?chainId=1' });
    expect(eth.json().balances[0].error).toBe('Ethereum RPC did not answer in time.');
    expect(eth.body).not.toContain('SECRETKEY');
  });
});

describe('BalanceService', () => {
  it('returns native balances across every configured chain', async () => {
    const chains = new Map<number, ChainServices>([
      [1, makeChain({ balance: parseEther('1.5') })],
      [8453, makeChain({ balance: parseEther('0.25') })],
    ]);
    const svc = new BalanceService(chains);

    const balances = await svc.getBalances(SOURCE);

    expect(balances).toHaveLength(2);
    expect(balances[0]!.chainId).toBe(1);
    expect(balances[0]!.formatted).toBe('1.5');
    expect(balances[1]!.formatted).toBe('0.25');
  });

  it('isolates a failing chain: one dead RPC does not fail the whole request', async () => {
    const chains = new Map<number, ChainServices>([
      [1, makeChain({ balanceThrows: true })],
      [8453, makeChain({ balance: parseEther('2') })],
    ]);
    const svc = new BalanceService(chains);

    const balances = await svc.getBalances(SOURCE);

    expect(balances[0]!.error).toBeDefined();
    expect(balances[1]!.formatted).toBe('2'); // the healthy chain still reports
  });
});

describe('DisperseService', () => {
  it('checks the source wallet\'s nonce counter before sending, and a failed check does not stop the sends', async () => {
    const order: string[] = [];
    const chain = makeChain({
      warmNonce: async (scope) => {
        order.push(`warm:${scope.chainId}:${scope.walletAddress}`);
        throw new Error('rpc down');
      },
    });
    const send = chain.transactionEngine.executeTransaction.bind(chain.transactionEngine);
    chain.transactionEngine.executeTransaction = (async (...args: Parameters<typeof send>) => {
      order.push('send');
      return send(...args);
    }) as typeof send;
    const svc = new DisperseService(makeWalletService(), new Map([[CHAIN_ID, chain]]), makePermissiveSpendCapResolver());

    const outcome = await svc.disperse({ ownerId: RESERVED_OPERATOR_USER_ID, sourceWalletId: 'w1', chainId: CHAIN_ID, recipients: [{ address: R1, amount: '0.01' }] });

    expect(outcome.ok).toBe(true);
    expect(order).toEqual([`warm:${CHAIN_ID}:${SOURCE}`, 'send']);
  });

  it('keeps the node\'s own words when a send is rejected, without the request body or the endpoint', async () => {
    const chain = makeChain({});
    chain.transactionEngine.executeTransaction = (async () => {
      throw new InvalidParamsRpcError(
        new RpcRequestError({ body: { method: 'eth_sendRawTransaction', params: ['0x02f9' + 'ab'.repeat(400)] }, url: 'https://rpc.example/v2/SECRET-API-KEY', error: { code: -32602, message: 'nonce too high: tx nonce 94, state nonce 90' } }),
      );
    }) as never;
    const svc = new DisperseService(makeWalletService(), new Map([[CHAIN_ID, chain]]), makePermissiveSpendCapResolver());

    const outcome = await svc.disperse({ ownerId: RESERVED_OPERATOR_USER_ID, sourceWalletId: 'w1', chainId: CHAIN_ID, recipients: [{ address: R1, amount: '0.01' }] });

    const error = outcome.results[0]?.error ?? '';
    expect(error).toContain('nonce too high: tx nonce 94, state nonce 90');
    expect(error).not.toContain('SECRET-API-KEY');
    expect(error).not.toContain('abab');
  });

  it('sends to every recipient sequentially and reports each one', async () => {
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({})]]);
    const svc = new DisperseService(makeWalletService(), chains, makePermissiveSpendCapResolver());

    const outcome = await svc.disperse({
      ownerId: RESERVED_OPERATOR_USER_ID,
      sourceWalletId: 'w1',
      chainId: CHAIN_ID,
      recipients: [
        { address: R1, amount: '0.01' },
        { address: R2, amount: '0.02' },
      ],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r) => r.status === 'sent')).toBe(true);
    // Nonces increment in order: proof the sends were sequential, not raced.
    expect(outcome.results[0]!.nonce).toBe(0);
    expect(outcome.results[1]!.nonce).toBe(1);
    expect(outcome.totalSentWei).toBe(parseEther('0.03').toString());
  });

  it('reports partial success per-recipient when one transfer fails', async () => {
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ failFor: new Set([R2]) })]]);
    const svc = new DisperseService(makeWalletService(), chains, makePermissiveSpendCapResolver());

    const outcome = await svc.disperse({
      ownerId: RESERVED_OPERATOR_USER_ID,
      sourceWalletId: 'w1',
      chainId: CHAIN_ID,
      recipients: [
        { address: R1, amount: '0.01' },
        { address: R2, amount: '0.01' },
        { address: R3, amount: '0.01' },
      ],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.results[0]!.status).toBe('sent');
    expect(outcome.results[1]!.status).toBe('failed');
    // The batch CONTINUES past a single bad recipient.
    expect(outcome.results[2]!.status).toBe('sent');
    // Only the successful transfers count toward total sent.
    expect(outcome.totalSentWei).toBe(parseEther('0.02').toString());
  });

  it('halts the whole batch on emergency stop and marks the rest skipped', async () => {
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ emergencyStopAt: R2 })]]);
    const svc = new DisperseService(makeWalletService(), chains, makePermissiveSpendCapResolver());

    const outcome = await svc.disperse({
      ownerId: RESERVED_OPERATOR_USER_ID,
      sourceWalletId: 'w1',
      chainId: CHAIN_ID,
      recipients: [
        { address: R1, amount: '0.01' },
        { address: R2, amount: '0.01' },
        { address: R3, amount: '0.01' },
      ],
    });

    expect(outcome.results[0]!.status).toBe('sent');
    expect(outcome.results[1]!.status).toBe('failed');
    // Unlike a normal failure, an emergency stop stops everything after it.
    expect(outcome.results[2]!.status).toBe('failed');
    expect(outcome.results[2]!.error).toMatch(/emergency stop/i);
  });

  it('halts the whole batch when a recipient crosses the daily spending cap, marking the rest skipped with per-recipient results reflecting reality (ADR-002 §3.7)', async () => {
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ spendingCapExceededAt: R2 })]]);
    const svc = new DisperseService(makeWalletService(), chains, makePermissiveSpendCapResolver());

    const outcome = await svc.disperse({
      ownerId: RESERVED_OPERATOR_USER_ID,
      sourceWalletId: 'w1',
      chainId: CHAIN_ID,
      recipients: [
        { address: R1, amount: '0.01' },
        { address: R2, amount: '0.01' },
        { address: R3, amount: '0.01' },
      ],
    });

    // Recipient 1 already has its funds: irreversible, real money moved.
    expect(outcome.results[0]!.status).toBe('sent');
    expect(outcome.results[0]!.hash).toBeTruthy();
    // Recipient 2 is the one that actually hit the cap.
    expect(outcome.results[1]!.status).toBe('failed');
    expect(outcome.results[1]!.error).toMatch(/daily spending cap exceeded/i);
    // Recipient 3 was never attempted: every later transfer would hit the same cap, so the batch stops
    // rather than trying (and failing) again.
    expect(outcome.results[2]!.status).toBe('failed');
    expect(outcome.results[2]!.error).toMatch(/spending cap/i);
    expect(outcome.results[2]!.hash).toBeUndefined();

    expect(outcome.ok).toBe(false);
    expect(outcome.haltReason).toBe('spending_cap_exceeded');
    // Only recipient 1's amount actually moved.
    expect(outcome.totalSentWei).toBe(parseEther('0.01').toString());
  });

  it('halts the whole batch when the chain becomes unreachable mid-batch, distinct from a cap/stop halt, with per-recipient results reflecting reality', async () => {
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ rpcUnavailableAt: R2 })]]);
    const svc = new DisperseService(makeWalletService(), chains, makePermissiveSpendCapResolver());

    const outcome = await svc.disperse({
      ownerId: RESERVED_OPERATOR_USER_ID,
      sourceWalletId: 'w1',
      chainId: CHAIN_ID,
      recipients: [
        { address: R1, amount: '0.01' },
        { address: R2, amount: '0.01' },
        { address: R3, amount: '0.01' },
      ],
    });

    expect(outcome.results[0]!.status).toBe('sent');
    expect(outcome.results[1]!.status).toBe('failed');
    expect(outcome.results[1]!.error).toMatch(/chain unreachable/i);
    // Recipient 3 was never attempted: a chain that is down fails every later transfer the same way,
    // so the batch stops.
    expect(outcome.results[2]!.status).toBe('failed');
    expect(outcome.results[2]!.error).toMatch(/chain was unreachable/i);
    expect(outcome.results[2]!.hash).toBeUndefined();

    expect(outcome.ok).toBe(false);
    expect(outcome.haltReason).toBe('rpc_unavailable');
    expect(outcome.totalSentWei).toBe(parseEther('0.01').toString());
  });

  it('rejects upfront when the source cannot cover amounts + gas, sending nothing', async () => {
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ balance: parseEther('0.005') })]]);
    const svc = new DisperseService(makeWalletService(), chains, makePermissiveSpendCapResolver());

    const outcome = await svc.disperse({
      ownerId: RESERVED_OPERATOR_USER_ID,
      sourceWalletId: 'w1',
      chainId: CHAIN_ID,
      recipients: [{ address: R1, amount: '1' }],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.preflightError).toBe('insufficient_balance');
    // Nothing was attempted: that's the point of a pre-flight check.
    expect(outcome.results).toHaveLength(0);
  });

  // 1 gwei gas price in the fake chain: 21,000 gas is 0.000021 and 600,000 gas is 0.0006 a transfer.
  const disperseWith = (chain: ChainServices, recipients: { address: `0x${string}`; amount: string }[]) =>
    new DisperseService(makeWalletService(), new Map([[CHAIN_ID, chain]]), makePermissiveSpendCapResolver()).disperse({ ownerId: RESERVED_OPERATOR_USER_ID, sourceWalletId: 'w1', chainId: CHAIN_ID, recipients });

  it('counts what a transfer really costs on this chain, not a fixed 21,000 gas', async () => {
    const recipients = [{ address: R1, amount: '0.001' }, { address: R2, amount: '0.001' }];
    // 0.002 to send. At 21,000 gas each the fees are 0.000042: a balance of 0.0025 looks like plenty.
    const balance = parseEther('0.0025');
    expect((await disperseWith(makeChain({ balance }), recipients)).ok).toBe(true);
    // On a chain where a transfer takes 600,000 gas the fees are 0.00132 (with the margin): not enough.
    const outcome = await disperseWith(makeChain({ balance, gasPerTransfer: 600_000n }), recipients);
    expect(outcome).toMatchObject({ ok: false, preflightError: 'insufficient_balance', results: [] });
    expect(outcome.detail).toMatch(/estimated gas/);
  });

  it('never assumes less than a plain transfer, whatever the chain estimates', async () => {
    const outcome = await disperseWith(makeChain({ balance: parseEther('0.00101'), gasPerTransfer: 1n }), [{ address: R1, amount: '0.001' }]);
    expect(outcome.preflightError).toBe('insufficient_balance'); // 0.001 + 0.000021 is more than 0.00101
  });

  it('refuses an amount of zero, naming the recipient, and sends nothing', async () => {
    for (const amount of ['0', '0.0', '0.000000000000000000']) {
      const outcome = await disperseWith(makeChain({}), [{ address: R1, amount: '0.01' }, { address: R2, amount }]);
      expect(outcome).toMatchObject({ ok: false, preflightError: 'zero_amount', results: [], totalSentWei: '0' });
      expect(outcome.detail).toContain(R2);
    }
  });

  it('a chain that cannot be read before sending is a plain refusal, not a thrown error', async () => {
    const outcome = await disperseWith(makeChain({ balanceThrows: true }), [{ address: R1, amount: '0.01' }]);
    expect(outcome).toMatchObject({ ok: false, preflightError: 'chain_unreachable', results: [] });
    expect(outcome.detail).toMatch(/nothing was sent/);
  });

  it('rejects an unconfigured chain before doing anything', async () => {
    const svc = new DisperseService(makeWalletService(), new Map(), makePermissiveSpendCapResolver());

    const outcome = await svc.disperse({
      ownerId: RESERVED_OPERATOR_USER_ID,
      sourceWalletId: 'w1',
      chainId: 999999,
      recipients: [{ address: R1, amount: '0.01' }],
    });

    expect(outcome.preflightError).toBe('unsupported_chain');
    expect(outcome.results).toHaveLength(0);
  });
});

describe('GET /chains/:chainId/transactions/:hash: has a broadcast transaction been mined?', () => {
  const HASH = `0x${'ab'.repeat(32)}`;

  /** Builds a real app whose one chain's publicClient answers getTransactionReceipt however the test says. */
  async function buildReceiptApp(getTransactionReceipt: (args: { hash: string }) => Promise<unknown>) {
    const { buildApp } = await import('../src/app.js');
    const { WalletKeyService, LocalKeyManagementProvider } = await import('@stryx/key-management');
    const { WalletService } = await import('@stryx/wallet-service');
    const { noopLogger } = await import('@stryx/logger');
    const { InMemoryWalletRepository } = await import('./fakes/in-memory-wallet.repository.js');

    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId);
    const chain = { ...makeChain({}), publicClient: { getTransactionReceipt } as never };
    const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
    return buildApp({
      walletService,
      logger: noopLogger,
      chainServices,
      balanceService: new BalanceService(chainServices),
      disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()),
    });
  }

  it('reports "success" with the block, gas used, and effective gas price once the transaction is mined', async () => {
    const app = await buildReceiptApp(async () => ({ status: 'success', blockNumber: 1234n, gasUsed: 21_000n, effectiveGasPrice: 1_500_000_000n }));

    const res = await app.inject({ method: 'GET', url: `/chains/${CHAIN_ID}/transactions/${HASH}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      chainId: CHAIN_ID,
      hash: HASH,
      status: 'success',
      blockNumber: '1234',
      gasUsed: '21000',
      effectiveGasPriceWei: '1500000000',
    });
  });

  it('reports "reverted" for a transaction that was mined but reverted: the chain state DID change (gas was spent)', async () => {
    const app = await buildReceiptApp(async () => ({ status: 'reverted', blockNumber: 99n, gasUsed: 21_000n, effectiveGasPrice: 1_500_000_000n }));

    const res = await app.inject({ method: 'GET', url: `/chains/${CHAIN_ID}/transactions/${HASH}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('reverted');
    expect(res.json().gasUsed).toBe('21000'); // gas was spent even on a revert
  });

  it('reports "pending", not an error, while no receipt exists yet', async () => {
    const app = await buildReceiptApp(async ({ hash }) => {
      throw new TransactionReceiptNotFoundError({ hash: hash as `0x${string}` });
    });

    const res = await app.inject({ method: 'GET', url: `/chains/${CHAIN_ID}/transactions/${HASH}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ chainId: CHAIN_ID, hash: HASH, status: 'pending' });
  });

  it('an unreachable RPC is a 502 rpc_unavailable, never mistaken for "pending", and its message does not echo the RPC URL', async () => {
    const app = await buildReceiptApp(async () => {
      throw new TimeoutError({ body: {}, url: 'https://rpc.example/v2/SECRET-API-KEY' });
    });

    const res = await app.inject({ method: 'GET', url: `/chains/${CHAIN_ID}/transactions/${HASH}` });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('rpc_unavailable');
    // viem's own error text embeds the request URL; for a keyed provider that is the key.
    expect(JSON.stringify(res.json())).not.toContain('SECRET-API-KEY');
  });

  it('rejects a chain with no RPC configured (400) and a malformed hash (400), without touching the chain', async () => {
    let calls = 0;
    const app = await buildReceiptApp(async () => {
      calls++;
      return { status: 'success', blockNumber: 1n };
    });

    const noChain = await app.inject({ method: 'GET', url: `/chains/999999/transactions/${HASH}` });
    const badHash = await app.inject({ method: 'GET', url: `/chains/${CHAIN_ID}/transactions/0x1234` });

    expect(noChain.statusCode).toBe(400);
    expect(noChain.json().error).toBe('unsupported_chain');
    expect(badHash.statusCode).toBe(400);
    expect(calls).toBe(0);
  });
});

describe('POST /chains/:chainId/transactions/receipts: the mint console\'s per-wallet gas-used lookup', () => {
  const HASH_A = `0x${'aa'.repeat(32)}`;
  const HASH_B = `0x${'bb'.repeat(32)}`;
  const HASH_C = `0x${'cc'.repeat(32)}`;

  async function buildBatchReceiptApp(getTransactionReceipt: (args: { hash: string }) => Promise<unknown>) {
    const { buildApp } = await import('../src/app.js');
    const { WalletKeyService, LocalKeyManagementProvider } = await import('@stryx/key-management');
    const { WalletService } = await import('@stryx/wallet-service');
    const { noopLogger } = await import('@stryx/logger');
    const { InMemoryWalletRepository } = await import('./fakes/in-memory-wallet.repository.js');

    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId);
    const chain = { ...makeChain({}), publicClient: { getTransactionReceipt } as never };
    const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
    return buildApp({
      walletService,
      logger: noopLogger,
      chainServices,
      balanceService: new BalanceService(chainServices),
      disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()),
    });
  }

  it('resolves several hashes in one call, mixing mined, pending, and a transport failure without one bad hash affecting the others', async () => {
    const app = await buildBatchReceiptApp(async ({ hash }) => {
      if (hash === HASH_A) return { status: 'success', blockNumber: 10n, gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n };
      if (hash === HASH_B) throw new TransactionReceiptNotFoundError({ hash: hash as `0x${string}` });
      if (hash === HASH_C) throw new TimeoutError({ body: {}, url: 'https://rpc.example/v2/SECRET-API-KEY' });
      throw new Error(`unexpected hash in test: ${hash}`);
    });

    const res = await app.inject({
      method: 'POST',
      url: `/chains/${CHAIN_ID}/transactions/receipts`,
      payload: { hashes: [HASH_A, HASH_B, HASH_C] },
    });

    expect(res.statusCode).toBe(200);
    const { receipts } = res.json();
    expect(receipts).toHaveLength(3);

    const a = receipts.find((r: { hash: string }) => r.hash === HASH_A);
    expect(a).toMatchObject({ status: 'success', blockNumber: '10', gasUsed: '21000', effectiveGasPriceWei: '1000000000' });

    const b = receipts.find((r: { hash: string }) => r.hash === HASH_B);
    expect(b).toEqual({ hash: HASH_B, status: 'pending' });

    const c = receipts.find((r: { hash: string }) => r.hash === HASH_C);
    expect(c.status).toBe('unknown');
    expect(JSON.stringify(c)).not.toContain('SECRET-API-KEY'); // same URL-leak guard as the single-hash route
  });

  it('with lookup, says whether the chain still has a transaction that has no receipt', async () => {
    const { buildApp } = await import('../src/app.js');
    const { WalletKeyService, LocalKeyManagementProvider } = await import('@stryx/key-management');
    const { WalletService } = await import('@stryx/wallet-service');
    const { noopLogger } = await import('@stryx/logger');
    const { InMemoryWalletRepository } = await import('./fakes/in-memory-wallet.repository.js');
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId);
    let lookups = 0;
    const publicClient = {
      async getTransactionReceipt({ hash }: { hash: string }) {
        throw new TransactionReceiptNotFoundError({ hash: hash as `0x${string}` });
      },
      async getTransaction({ hash }: { hash: string }) {
        lookups += 1;
        if (hash === HASH_A) return { hash };
        if (hash === HASH_B) throw new TransactionNotFoundError({ hash: hash as `0x${string}` });
        throw new TimeoutError({ body: {}, url: 'https://rpc.example/v2/SECRET-API-KEY' });
      },
    };
    const chain = { ...makeChain({}), publicClient: publicClient as never };
    const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
    const app = buildApp({ walletService, logger: noopLogger, chainServices, balanceService: new BalanceService(chainServices), disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()) });

    const plain = await app.inject({ method: 'POST', url: `/chains/${CHAIN_ID}/transactions/receipts`, payload: { hashes: [HASH_B] } });
    expect(plain.json().receipts).toEqual([{ hash: HASH_B, status: 'pending' }]);
    expect(lookups).toBe(0); // the extra read happens only when asked for

    const res = await app.inject({ method: 'POST', url: `/chains/${CHAIN_ID}/transactions/receipts`, payload: { hashes: [HASH_A, HASH_B, HASH_C], lookup: true } });
    const byHash = Object.fromEntries(res.json().receipts.map((r: { hash: string; status: string }) => [r.hash, r.status]));
    expect(byHash).toEqual({ [HASH_A]: 'pending', [HASH_B]: 'not_found', [HASH_C]: 'pending' }); // a failed read proves nothing
  });

  it('rejects an empty or oversized hash list, and a chain with no RPC configured', async () => {
    const app = await buildBatchReceiptApp(async () => ({ status: 'success', blockNumber: 1n, gasUsed: 21_000n, effectiveGasPrice: 1n }));

    const empty = await app.inject({ method: 'POST', url: `/chains/${CHAIN_ID}/transactions/receipts`, payload: { hashes: [] } });
    const tooMany = await app.inject({ method: 'POST', url: `/chains/${CHAIN_ID}/transactions/receipts`, payload: { hashes: Array.from({ length: 51 }, () => HASH_A) } });
    const noChain = await app.inject({ method: 'POST', url: `/chains/999999/transactions/receipts`, payload: { hashes: [HASH_A] } });

    expect(empty.statusCode).toBe(400);
    expect(tooMany.statusCode).toBe(400);
    expect(noChain.statusCode).toBe(400);
    expect(noChain.json().error).toBe('unsupported_chain');
  });
});

describe('POST /chains/:chainId/wallets/warm-nonces: paying the nonce read ahead of a mint', () => {
  async function buildWarmNonceApp(warmNonce: (scope: { chainId: number; walletAddress: string }) => Promise<void>, walletCount = 1) {
    const { buildApp } = await import('../src/app.js');
    const { WalletKeyService, LocalKeyManagementProvider } = await import('@stryx/key-management');
    const { WalletService } = await import('@stryx/wallet-service');
    const { noopLogger } = await import('@stryx/logger');
    const { InMemoryWalletRepository } = await import('./fakes/in-memory-wallet.repository.js');

    const repository = new InMemoryWalletRepository();
    const kms = new LocalKeyManagementProvider();
    const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
    const wallets = await Promise.all(Array.from({ length: walletCount }, () => walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID)));

    const chain = { ...makeChain({}), transactionEngine: { warmNonce } as never };
    const chainServices = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
    const app = buildApp({
      walletService,
      logger: noopLogger,
      chainServices,
      balanceService: new BalanceService(chainServices),
      disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()),
    });
    return { app, walletIds: wallets.map((w) => w.id) };
  }

  it('warms every requested wallet and reports how many succeeded', async () => {
    const warmed: string[] = [];
    const { app, walletIds } = await buildWarmNonceApp(async (scope) => {
      warmed.push(scope.walletAddress);
    }, 3);

    const res = await app.inject({ method: 'POST', url: `/chains/${CHAIN_ID}/wallets/warm-nonces`, payload: { walletIds } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ warmed: 3 });
    expect(warmed).toHaveLength(3);
  });

  it('a wallet whose warm fails is swallowed, not surfaced as an error: the request still succeeds with a lower count', async () => {
    let calls = 0;
    const { app, walletIds } = await buildWarmNonceApp(async () => {
      calls++;
      if (calls === 2) throw new Error('simulated RPC timeout warming this wallet');
    }, 3);

    const res = await app.inject({ method: 'POST', url: `/chains/${CHAIN_ID}/wallets/warm-nonces`, payload: { walletIds } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ warmed: 2 }); // 2 of 3 succeeded, the request itself never fails
  });

  it('rejects an empty or oversized wallet list, and a chain with no RPC configured', async () => {
    const { app, walletIds } = await buildWarmNonceApp(async () => undefined, 1);

    const empty = await app.inject({ method: 'POST', url: `/chains/${CHAIN_ID}/wallets/warm-nonces`, payload: { walletIds: [] } });
    const tooMany = await app.inject({ method: 'POST', url: `/chains/${CHAIN_ID}/wallets/warm-nonces`, payload: { walletIds: Array.from({ length: 101 }, () => walletIds[0]) } });
    const noChain = await app.inject({ method: 'POST', url: '/chains/999999/wallets/warm-nonces', payload: { walletIds } });

    expect(empty.statusCode).toBe(400);
    expect(tooMany.statusCode).toBe(400);
    expect(noChain.statusCode).toBe(400);
    expect(noChain.json().error).toBe('unsupported_chain');
  });
});

describe('DisperseService: amounts in the chain\'s own token', () => {
  it('a short BNB Chain wallet is told in BNB, never ETH', async () => {
    const chainServices = new Map<number, ChainServices>([[56, makeChain({ balance: parseEther('0.5') })]]);
    const service = new DisperseService(makeWalletService(), chainServices, makePermissiveSpendCapResolver());
    const out = await service.disperse({
      ownerId: RESERVED_OPERATOR_USER_ID,
      sourceWalletId: 'w1',
      chainId: 56,
      recipients: [{ address: '0x2222222222222222222222222222222222222222', amount: '1' }],
    });
    expect(out.preflightError).toBe('insufficient_balance');
    expect(out.detail).toMatch(/^Source wallet holds 0\.5 BNB but needs ~1\.\d+ BNB \(1 BNB to send/);
    expect(out.detail).not.toContain('ETH');
  });
});

describe('disperseAuditDetail', () => {
  it('names the chain and the hashes, and says broadcast, not sent', async () => {
    const { disperseAuditDetail } = await import('../src/wallet-ops-controller.js');
    const detail = disperseAuditDetail(1, {
      totalSentWei: '200000000000000',
      results: [
        { status: 'sent', hash: '0xaaa' },
        { status: 'unknown', hash: '0xbbb' },
        { status: 'failed' },
      ],
    });
    expect(detail).toBe('chain 1: broadcast 1 of 3 transfer(s), 200000000000000 wei, 1 outcome unknown; hashes 0xaaa 0xbbb');
  });

  it('leads with the reason a batch was halted, and caps the hash list', async () => {
    const { disperseAuditDetail } = await import('../src/wallet-ops-controller.js');
    const results = Array.from({ length: 7 }, (_, i) => ({ status: 'sent', hash: `0x${i}` }));
    const detail = disperseAuditDetail(4663, { haltReason: 'emergency_stop', totalSentWei: '7', results });
    expect(detail).toBe('emergency_stop: chain 4663: broadcast 7 of 7 transfer(s), 7 wei; hashes 0x0 0x1 0x2 0x3 0x4 and 2 more');
  });
});
