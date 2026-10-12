import { keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, recoverTransactionAddress } from 'viem';
import { WalletKeyService, LocalKeyManagementProvider, type EncryptedPrivateKeyRecord } from '@stryx/key-management';
import { NonceManager, type ChainNonceReader } from '@stryx/nonce-manager';
import { TransactionEngine, spendBudgetId, walletBudgetId } from '../src/service/transaction-engine.service.js';
import { EmergencyStopGuard } from '../src/service/emergency-stop.service.js';
import { SpendingCapGuard } from '../src/service/spending-cap.service.js';
import { GasEstimator } from '../src/service/gas-estimator.service.js';
import { TransactionSimulator } from '../src/service/transaction-simulator.service.js';
import { TransactionSigner, type WalletKeyRecordProvider } from '../src/service/transaction-signer.service.js';
import {
  BroadcastUncertainError,
  EmergencyStopActiveError,
  SimulationRevertedError,
  SpendingCapExceededError,
  RpcUnavailableError,
} from '../src/types/errors.js';
import type { TransactionScope, UnsignedTransactionRequest } from '../src/types/transaction.types.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { fakePublicClient, type FakePublicClientOptions } from './fakes/fake-public-client.js';

const zeroChainReader: ChainNonceReader = {
  async getPendingNonce() {
    return 0;
  },
};

async function buildTestRig(clientOpts: FakePublicClientOptions = {}, walletId = 'wallet-1', chainReader: ChainNonceReader = zeroChainReader) {
  const privateKey = generatePrivateKey();
  const walletAddress = privateKeyToAccount(privateKey).address;

  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const record = await walletKeyService.encryptPrivateKeyForStorage(
    { walletId },
    Buffer.from(privateKey.slice(2), 'hex'),
  );

  const recordProvider: WalletKeyRecordProvider = {
    async getRecord(id: string): Promise<EncryptedPrivateKeyRecord> {
      if (id !== walletId) throw new Error('unknown wallet in test fake');
      return record;
    },
  };

  const redis = new InMemoryRedisClient();
  const nonceManager = new NonceManager(redis, chainReader);
  const emergencyStopGuard = new EmergencyStopGuard(redis);
  const spendingCapGuard = new SpendingCapGuard(redis);
  const client = fakePublicClient(clientOpts);

  const engine = new TransactionEngine(
    nonceManager,
    emergencyStopGuard,
    spendingCapGuard,
    new GasEstimator(client),
    new TransactionSimulator(client),
    new TransactionSigner(walletKeyService, recordProvider),
    client,
  );

  const scope: TransactionScope = { chainId: 1, walletId, walletAddress, ownerId: 'owner-1', spendCapWei: null };
  return { engine, scope, client, redis, emergencyStopGuard, spendingCapGuard, nonceManager, walletAddress };
}

const unsignedTx: UnsignedTransactionRequest = {
  to: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  data: '0xdeadbeef',
  value: 10_000_000_000_000n,
};

describe('TransactionEngine', () => {
  it('executes a transaction end-to-end: correct nonce, broadcast succeeds', async () => {
    const { engine, scope, client } = await buildTestRig({
      broadcastHash: ('0x' + '11'.repeat(32)) as `0x${string}`,
    });

    const result = await engine.executeTransaction(scope, unsignedTx);

    expect(result.status).toBe('broadcast');
    expect(result.nonce).toBe(0);
    expect(result.hash).toBe('0x' + '11'.repeat(32));
    expect(client.calls.sendRawTransaction).toBe(1);
  });

  it('onSigned gets the hash of the exact signed bytes BEFORE they are sent', async () => {
    const order: string[] = [];
    let sent: `0x${string}` | undefined;
    const { engine, scope } = await buildTestRig({
      captureBroadcast: (serializedTransaction) => {
        order.push('send');
        sent = serializedTransaction;
      },
    });
    let hooked: { hash: `0x${string}`; nonce: number } | undefined;
    await engine.executeTransaction(scope, unsignedTx, {
      onSigned: (signed) => {
        order.push('signed');
        hooked = signed;
      },
    });
    expect(order).toEqual(['signed', 'send']);
    expect(hooked).toEqual({ hash: keccak256(sent!), nonce: 0 }); // the on-chain hash of what went out
  });

  it('a failing onSigned hook is logged and the send still goes ahead', async () => {
    const { engine, scope, client } = await buildTestRig();
    const result = await engine.executeTransaction(scope, unsignedTx, {
      onSigned: () => {
        throw new Error('database down');
      },
    });
    expect(result.status).toBe('broadcast');
    expect(client.calls.sendRawTransaction).toBe(1);
  });

  it('onSigned is not called when nothing is signed (a stopped wallet)', async () => {
    const { engine, scope, emergencyStopGuard } = await buildTestRig();
    await emergencyStopGuard.triggerWalletStop(scope.walletId, 'test');
    let called = false;
    await expect(engine.executeTransaction(scope, unsignedTx, { onSigned: () => void (called = true) })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("signs with the correct key: the broadcast transaction recovers to the wallet's own address", async () => {
    let capturedSignedTx: `0x${string}` | undefined;
    const { engine, scope, walletAddress } = await buildTestRig({
      captureBroadcast: (serializedTransaction) => {
        capturedSignedTx = serializedTransaction;
      },
    });

    await engine.executeTransaction(scope, unsignedTx);

    expect(capturedSignedTx).toBeDefined();
    const parsed = parseTransaction(capturedSignedTx!);
    expect(parsed.to?.toLowerCase()).toBe(unsignedTx.to.toLowerCase());
    expect(parsed.nonce).toBe(0);
    expect(parsed.chainId).toBe(1);

    const recoveredAddress = await recoverTransactionAddress({
      serializedTransaction: capturedSignedTx as `0x02${string}`,
    });
    expect(recoveredAddress.toLowerCase()).toBe(walletAddress.toLowerCase());
  });

  it('signs with the chosen priority fee: the tip is swapped in, the base part kept', async () => {
    let signed: `0x${string}` | undefined;
    const { engine, scope } = await buildTestRig({ captureBroadcast: (tx) => (signed = tx) });

    await engine.executeTransaction(scope, unsignedTx, { priorityFeeWei: 7_000_000_000n });

    const parsed = parseTransaction(signed!);
    expect(parsed.maxPriorityFeePerGas).toBe(7_000_000_000n);
    expect(parsed.maxFeePerGas).toBe(36_000_000_000n); // 30 suggested - 1 suggested tip + 7
  });

  it('a tighter gas buffer (chains that charge the whole limit) pads the estimate less', async () => {
    const { client } = await buildTestRig({ gas: 100_000n });
    const scope = { chainId: 143, walletId: 'w', walletAddress: '0x0000000000000000000000000000000000000001', ownerId: 'o', spendCapWei: null };
    expect((await new GasEstimator(client).estimate(scope, unsignedTx)).gas).toBe(120_000n);
    expect((await new GasEstimator(client, null, 110n).estimate(scope, unsignedTx)).gas).toBe(110_000n);
  });

  it("spend caps are per chain: a send on chain 1 draws only on that chain's budget", async () => {
    const { engine, scope, spendingCapGuard } = await buildTestRig();
    const capped = { ...scope, spendCapWei: unsignedTx.value };
    await engine.executeTransaction(capped, unsignedTx);
    expect((await spendingCapGuard.reserve(`${scope.ownerId}:1`, 1n, unsignedTx.value)).ok).toBe(false); // chain 1 is full
    expect((await spendingCapGuard.reserve(`${scope.ownerId}:56`, unsignedTx.value, unsignedTx.value)).ok).toBe(true); // BNB untouched
    expect(spendBudgetId({ ownerId: 'u', chainId: 56 })).toBe('u:56');
  });

  it('calls gas estimation and fee estimation exactly once per execution', async () => {
    const { engine, scope, client } = await buildTestRig({ gas: 100_000n });

    await engine.executeTransaction(scope, unsignedTx);

    expect(client.calls.estimateGas).toBe(1);
    expect(client.calls.estimateFeesPerGas).toBe(1);
  });

  it('throws SimulationRevertedError, NOT RpcUnavailableError, when the pre-sign simulation reverts, and never allocates a nonce (regression: a revert must never be classified as retryable)', async () => {
    const { engine, scope, nonceManager } = await buildTestRig({ callShouldRevert: true });

    const err = await engine.executeTransaction(scope, unsignedTx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulationRevertedError);
    // The RPC call succeeded and the chain reverted: retrying with the same inputs would fail the same
    // way.
    expect(err).not.toBeInstanceOf(RpcUnavailableError);

    const nonce = await nonceManager.getNextNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress });
    expect(nonce).toBe(0);
  });

  it('throws SimulationRevertedError, NOT RpcUnavailableError, when GAS ESTIMATION reverts (regression), the checkpoint that actually runs FIRST, before eth_call ever gets a turn', async () => {
    const { engine, scope, client } = await buildTestRig({ estimateGasShouldRevert: true });

    const err = await engine.executeTransaction(scope, unsignedTx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulationRevertedError);
    expect(err).not.toBeInstanceOf(RpcUnavailableError);
    // Simulation (eth_call) is never even reached: estimateGas already reverted.
    expect(client.calls.call).toBe(0);
    expect(client.calls.sendRawTransaction).toBe(0);
  });

  it('throws RpcUnavailableError, not SimulationRevertedError, when gas estimation fails because the RPC itself is unreachable', async () => {
    const { engine, scope, client } = await buildTestRig({ estimateGasShouldTimeout: true });

    const err = await engine.executeTransaction(scope, unsignedTx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcUnavailableError);
    expect(err).not.toBeInstanceOf(SimulationRevertedError);
    expect((err as RpcUnavailableError).stage).toBe('gas-estimation');
    expect(client.calls.sendRawTransaction).toBe(0);
  });

  it('throws RpcUnavailableError, not SimulationRevertedError, when the pre-sign simulation fails because the RPC itself is unreachable', async () => {
    const { engine, scope, client } = await buildTestRig({ callShouldTimeout: true });

    const err = await engine.executeTransaction(scope, unsignedTx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcUnavailableError);
    expect(err).not.toBeInstanceOf(SimulationRevertedError);
    expect((err as RpcUnavailableError).stage).toBe('pre-simulation');
    expect(client.calls.sendRawTransaction).toBe(0);
  });

  it('never allocates a nonce when the RPC becomes unavailable at simulation (after gas estimation already succeeded)', async () => {
    const { engine, scope, nonceManager } = await buildTestRig({ callShouldTimeout: true });

    await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow(RpcUnavailableError);

    // Nonce allocation happens AFTER simulate() succeeds: a failure there means it's never reached,
    // not that it was allocated then released.
    const nonce = await nonceManager.getNextNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress });
    expect(nonce).toBe(0);
  });

  it('rejects immediately with EmergencyStopActiveError when a global stop is already active, before any RPC calls', async () => {
    const { engine, scope, client, emergencyStopGuard } = await buildTestRig({});
    await emergencyStopGuard.triggerGlobalStop('test: global stop');

    await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow(EmergencyStopActiveError);

    expect(client.calls.estimateGas).toBe(0);
    expect(client.calls.call).toBe(0);
  });

  it('rejects with EmergencyStopActiveError when a wallet-scoped stop is active', async () => {
    const { engine, scope, emergencyStopGuard } = await buildTestRig({});
    await emergencyStopGuard.triggerWalletStop(scope.walletId, 'test: wallet stop');

    await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow(EmergencyStopActiveError);
  });

  it('catches a stop pressed mid-flow at the pre-sign checkpoint, and releases the allocated nonce for reuse', async () => {
    const walletId = 'wallet-mid-flow';
    const privateKey = generatePrivateKey();
    const walletAddress = privateKeyToAccount(privateKey).address;

    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);
    const record = await walletKeyService.encryptPrivateKeyForStorage(
      { walletId },
      Buffer.from(privateKey.slice(2), 'hex'),
    );
    const recordProvider: WalletKeyRecordProvider = {
      async getRecord() {
        return record;
      },
    };

    const redis = new InMemoryRedisClient();
    const nonceManager = new NonceManager(redis, zeroChainReader);
    const emergencyStopGuard = new EmergencyStopGuard(redis);

    // The stop is triggered during the simulation itself, as if pressed while the request was in
    // flight.
    const client = fakePublicClient({
      onCall: () => {
        void emergencyStopGuard.triggerWalletStop(walletId, 'pressed mid-flow');
      },
    });

    const engine = new TransactionEngine(
      nonceManager,
      emergencyStopGuard,
      new SpendingCapGuard(redis),
      new GasEstimator(client),
      new TransactionSimulator(client),
      new TransactionSigner(walletKeyService, recordProvider),
      client,
    );

    const scope: TransactionScope = { chainId: 1, walletId, walletAddress, ownerId: 'owner-1', spendCapWei: null };

    await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow(EmergencyStopActiveError);
    expect(client.calls.sendRawTransaction).toBe(0);

    // The nonce allocated before the stop was caught must be released and reused.
    const nextNonce = await nonceManager.getNextNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress });
    expect(nextNonce).toBe(0);
  });

  it('rejects with EmergencyStopActiveError when a USER-scoped stop is active (ADR-002 §3.7), even with no wallet or global stop', async () => {
    const { engine, scope, emergencyStopGuard } = await buildTestRig({});
    await emergencyStopGuard.triggerUserStop(scope.ownerId, 'test: user stop');

    await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow(EmergencyStopActiveError);
  });

  it('a user-scoped stop halts every wallet belonging to that user, not just one, but leaves other users unaffected', async () => {
    const redis = new InMemoryRedisClient();
    const emergencyStopGuard = new EmergencyStopGuard(redis);

    async function engineFor(walletId: string) {
      const privateKey = generatePrivateKey();
      const walletAddress = privateKeyToAccount(privateKey).address;
      const kms = new LocalKeyManagementProvider();
      const walletKeyService = new WalletKeyService(kms);
      const record = await walletKeyService.encryptPrivateKeyForStorage({ walletId }, Buffer.from(privateKey.slice(2), 'hex'));
      const recordProvider: WalletKeyRecordProvider = { async getRecord() { return record; } };
      const client = fakePublicClient({});
      const nonceManager = new NonceManager(redis, zeroChainReader);
      const engine = new TransactionEngine(
        nonceManager,
        emergencyStopGuard,
        new SpendingCapGuard(redis),
        new GasEstimator(client),
        new TransactionSimulator(client),
        new TransactionSigner(walletKeyService, recordProvider),
        client,
      );
      return { engine, walletAddress };
    }

    const walletOne = await engineFor('user-a-wallet-1');
    const walletTwo = await engineFor('user-a-wallet-2');
    const otherUsersWallet = await engineFor('user-b-wallet-1');

    await emergencyStopGuard.triggerUserStop('user-a', 'test: whole account stopped');

    const scope1: TransactionScope = { chainId: 1, walletId: 'user-a-wallet-1', walletAddress: walletOne.walletAddress, ownerId: 'user-a', spendCapWei: null };
    const scope2: TransactionScope = { chainId: 1, walletId: 'user-a-wallet-2', walletAddress: walletTwo.walletAddress, ownerId: 'user-a', spendCapWei: null };
    const scopeOther: TransactionScope = { chainId: 1, walletId: 'user-b-wallet-1', walletAddress: otherUsersWallet.walletAddress, ownerId: 'user-b', spendCapWei: null };

    await expect(walletOne.engine.executeTransaction(scope1, unsignedTx)).rejects.toThrow(EmergencyStopActiveError);
    await expect(walletTwo.engine.executeTransaction(scope2, unsignedTx)).rejects.toThrow(EmergencyStopActiveError);
    // A different user, same shared guard instance: unaffected.
    await expect(otherUsersWallet.engine.executeTransaction(scopeOther, unsignedTx)).resolves.toBeDefined();
  });

  it('clearUserStop lifts a user-scoped stop', async () => {
    const { engine, scope, emergencyStopGuard } = await buildTestRig({});
    await emergencyStopGuard.triggerUserStop(scope.ownerId, 'test');
    await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow(EmergencyStopActiveError);

    await emergencyStopGuard.clearUserStop(scope.ownerId);

    await expect(engine.executeTransaction(scope, unsignedTx)).resolves.toBeDefined();
  });

  it('rejects with SpendingCapExceededError when the transaction would exceed the owner\'s daily cap, and never broadcasts', async () => {
    const { engine, scope, client } = await buildTestRig({});
    const scopeWithCap = { ...scope, spendCapWei: unsignedTx.value - 1n }; // one wei short of what this tx needs

    await expect(engine.executeTransaction(scopeWithCap, unsignedTx)).rejects.toThrow(SpendingCapExceededError);
    expect(client.calls.sendRawTransaction).toBe(0);
  });

  it("per-wallet caps: one wallet is refused once it uses its share, while the account and its other wallets still have room", async () => {
    const { engine, scope, client, spendingCapGuard } = await buildTestRig({});
    // The account could afford three of these today; each wallet only one.
    const capped = { ...scope, spendCapWei: unsignedTx.value * 3n, walletSpendCapWei: unsignedTx.value };
    await engine.executeTransaction(capped, unsignedTx);
    const err = await engine.executeTransaction(capped, unsignedTx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendingCapExceededError);
    expect((err as SpendingCapExceededError).budget).toBe('wallet');
    expect((err as Error).message).toMatch(/for this wallet/);
    expect(client.calls.sendRawTransaction).toBe(1);
    // The refused send gave its account reservation back: two sends' worth is still free there.
    expect((await spendingCapGuard.reserve(spendBudgetId(scope), unsignedTx.value * 2n, unsignedTx.value * 3n)).ok).toBe(true);
    expect(walletBudgetId({ ownerId: 'u', chainId: 1, walletId: 'w' })).toBe('u:1:wallet:w');
  });

  it('per-wallet caps: a send that fails after both reservations gives both back', async () => {
    const { engine, scope, spendingCapGuard } = await buildTestRig({
      captureBroadcast: () => {
        throw new Error('node refused the transaction');
      },
    });
    const capped = { ...scope, spendCapWei: unsignedTx.value, walletSpendCapWei: unsignedTx.value };
    await expect(engine.executeTransaction(capped, unsignedTx)).rejects.toThrow('node refused');
    expect((await spendingCapGuard.reserve(spendBudgetId(scope), unsignedTx.value, unsignedTx.value)).ok).toBe(true);
    expect((await spendingCapGuard.reserve(walletBudgetId(scope), unsignedTx.value, unsignedTx.value)).ok).toBe(true);
  });

  it('allows a transaction that lands exactly at the cap', async () => {
    const { engine, scope } = await buildTestRig({});
    const scopeWithCap = { ...scope, spendCapWei: unsignedTx.value };

    await expect(engine.executeTransaction(scopeWithCap, unsignedTx)).resolves.toBeDefined();
  });

  it('releases the spending-cap reservation (and the nonce) when signing fails AFTER the cap was already reserved', async () => {
    const walletId = 'wallet-cap-rollback';
    // A record provider that always fails: the reservation succeeds first, then signing throws, which
    // exercises the rollback.
    const failingRecordProvider: WalletKeyRecordProvider = {
      async getRecord(): Promise<EncryptedPrivateKeyRecord> {
        throw new Error('simulated key-unwrap failure, after the cap checkpoint has already run');
      },
    };

    const redis = new InMemoryRedisClient();
    const nonceManager = new NonceManager(redis, zeroChainReader);
    const emergencyStopGuard = new EmergencyStopGuard(redis);
    const spendingCapGuard = new SpendingCapGuard(redis);
    const client = fakePublicClient({});
    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);

    const engine = new TransactionEngine(
      nonceManager,
      emergencyStopGuard,
      spendingCapGuard,
      new GasEstimator(client),
      new TransactionSimulator(client),
      new TransactionSigner(walletKeyService, failingRecordProvider),
      client,
    );

    const scope: TransactionScope = {
      chainId: 1,
      walletId,
      walletAddress: privateKeyToAccount(generatePrivateKey()).address,
      ownerId: 'owner-rollback',
      spendCapWei: unsignedTx.value, // exactly enough for one send
    };

    await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow('simulated key-unwrap failure');

    // If the reservation weren't rolled back, this second attempt (needing the FULL cap again) would
    // be refused as exceeding it.
    const reservation = await spendingCapGuard.reserve(spendBudgetId(scope), unsignedTx.value, unsignedTx.value);
    expect(reservation).toMatchObject({ ok: true, total: unsignedTx.value });
  });

  it('fails closed: if the spending-cap store is unreadable, the transaction is REFUSED, not permitted, never signs or broadcasts', async () => {
    const walletId = 'wallet-cap-unreadable';
    const privateKey = generatePrivateKey();
    const walletAddress = privateKeyToAccount(privateKey).address;
    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);
    const record = await walletKeyService.encryptPrivateKeyForStorage(
      { walletId },
      Buffer.from(privateKey.slice(2), 'hex'),
    );
    const recordProvider: WalletKeyRecordProvider = { async getRecord() { return record; } };

    const redis = new InMemoryRedisClient();
    const nonceManager = new NonceManager(redis, zeroChainReader);
    const emergencyStopGuard = new EmergencyStopGuard(redis);
    // A cap store that can't be read at all: simulates Redis being down for the spend-cap keys
    // specifically.
    const unreadableCapGuard = new SpendingCapGuard({
      async get(): Promise<string | null> {
        throw new Error('simulated Redis outage reading spend counter');
      },
      // The lock's own set must succeed; only the day counter's read fails here.
      async set(_key: string, _value: string, opts?: unknown): Promise<unknown> {
        if (opts && typeof opts === 'object' && 'NX' in opts) return 'OK';
        throw new Error('should never be reached');
      },
      async eval(): Promise<unknown> {
        return 1; // lock release: irrelevant to what's under test here
      },
    });
    const client = fakePublicClient({});

    const engine = new TransactionEngine(
      nonceManager,
      emergencyStopGuard,
      unreadableCapGuard,
      new GasEstimator(client),
      new TransactionSimulator(client),
      new TransactionSigner(walletKeyService, recordProvider),
      client,
    );

    const scope: TransactionScope = {
      chainId: 1,
      walletId,
      walletAddress,
      ownerId: 'owner-unreadable-cap',
      spendCapWei: 1_000_000n, // capped, not unlimited: the unlimited path would correctly skip Redis entirely
    };

    await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow('simulated Redis outage');
    expect(client.calls.sendRawTransaction).toBe(0);

    // The nonce allocated before the cap check failed must still be released for reuse: a refused
    // transaction shouldn't burn a nonce.
    const nextNonce = await nonceManager.getNextNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress });
    expect(nextNonce).toBe(0);
  });

  it('fails closed: if the emergency-stop store is unreadable, the transaction is REFUSED before anything else runs, not permitted', async () => {
    // isStopped is checked FIRST, at 'strategy-evaluation', before gas estimation, nonce allocation,
    // or signing, so an unreadable store must reject right there.
    const { scope, client, nonceManager, spendingCapGuard } = await buildTestRig({});

    const unreadableStopGuard = new EmergencyStopGuard({
      async get(): Promise<string | null> {
        throw new Error('simulated Redis outage reading emergency-stop flags');
      },
      async set(): Promise<unknown> {
        throw new Error('should never be reached');
      },
      async del(): Promise<unknown> {
        throw new Error('should never be reached');
      },
    });
    const kms = new LocalKeyManagementProvider();
    const walletKeyService = new WalletKeyService(kms);
    const recordProvider: WalletKeyRecordProvider = {
      async getRecord() {
        throw new Error('should never be reached: the stop check must fail before signing is attempted');
      },
    };

    const engine = new TransactionEngine(
      nonceManager,
      unreadableStopGuard,
      spendingCapGuard,
      new GasEstimator(client),
      new TransactionSimulator(client),
      new TransactionSigner(walletKeyService, recordProvider),
      client,
    );

    await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow(
      'simulated Redis outage reading emergency-stop flags',
    );
    expect(client.calls.estimateGas).toBe(0);
    expect(client.calls.call).toBe(0);
    expect(client.calls.sendRawTransaction).toBe(0);
  });

  describe('a send call that throws', () => {
    const sendFails = { captureBroadcast: () => { throw new Error('request timed out'); } };
    const nonceScope = (walletAddress: string) => ({ chainId: 1, walletAddress });
    /** A chain whose pending nonce the test can move, as if something else sent from the wallet. */
    const movableReader = () => {
      const state = { pending: 0, down: false };
      const reader: ChainNonceReader = {
        async getPendingNonce() {
          if (state.down) throw new Error('rpc down');
          return state.pending;
        },
      };
      return { state, reader };
    };

    it('is a broadcast when the chain has the transaction: nonce kept, budget still charged', async () => {
      const { engine, scope, nonceManager, spendingCapGuard } = await buildTestRig({ ...sendFails, transactionLookup: 'known' });
      const capped = { ...scope, spendCapWei: unsignedTx.value };

      const result = await engine.executeTransaction(capped, unsignedTx);

      expect(result.status).toBe('broadcast');
      expect(result.nonce).toBe(0);
      expect(await nonceManager.getNextNonce(nonceScope(scope.walletAddress))).toBe(1);
      expect((await spendingCapGuard.reserve(spendBudgetId(scope), 1n, unsignedTx.value)).ok).toBe(false);
    });

    it('releases the nonce when the chain does not have it and the nonce is still free', async () => {
      const { engine, scope, nonceManager } = await buildTestRig(sendFails);
      await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toThrow('request timed out');
      expect(await nonceManager.getNextNonce(nonceScope(scope.walletAddress))).toBe(0);
    });

    it('a wallet used outside Stryx: the stale nonce is dropped and the counter catches up to the chain', async () => {
      const { state, reader } = movableReader();
      const { engine, scope, nonceManager, spendingCapGuard } = await buildTestRig(sendFails, 'wallet-1', reader);
      await engine.warmNonce(nonceScope(scope.walletAddress));
      state.pending = 5;
      const capped = { ...scope, spendCapWei: unsignedTx.value };

      await expect(engine.executeTransaction(capped, unsignedTx)).rejects.toThrow('request timed out');

      expect(await nonceManager.getNextNonce(nonceScope(scope.walletAddress))).toBe(5);
      expect((await spendingCapGuard.reserve(spendBudgetId(scope), unsignedTx.value, unsignedTx.value)).ok).toBe(true);
    });

    it('is reported as unknown, with the hash, when the nonce is used and the node cannot say by what', async () => {
      const { state, reader } = movableReader();
      const { engine, scope, nonceManager, spendingCapGuard } = await buildTestRig({ ...sendFails, transactionLookup: 'unreachable' }, 'wallet-1', reader);
      await engine.warmNonce(nonceScope(scope.walletAddress));
      state.pending = 1;
      const capped = { ...scope, spendCapWei: unsignedTx.value };

      const err = await engine.executeTransaction(capped, unsignedTx).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BroadcastUncertainError);
      expect((err as BroadcastUncertainError).hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect((err as BroadcastUncertainError).nonce).toBe(0);
      expect(await nonceManager.getNextNonce(nonceScope(scope.walletAddress))).toBe(1);
      expect((await spendingCapGuard.reserve(spendBudgetId(scope), 1n, unsignedTx.value)).ok).toBe(false);
    });

    it('is reported as unknown when the chain cannot be asked at all', async () => {
      const { state, reader } = movableReader();
      const { engine, scope } = await buildTestRig({ ...sendFails, transactionLookup: 'unreachable' }, 'wallet-1', reader);
      await engine.warmNonce(nonceScope(scope.walletAddress));
      state.down = true;

      await expect(engine.executeTransaction(scope, unsignedTx)).rejects.toBeInstanceOf(BroadcastUncertainError);
    });

    it('never loops on "nonce too low": the send after a landed-but-failed one gets a fresh nonce', async () => {
      const { state, reader } = movableReader();
      const rig = await buildTestRig({ transactionLookup: 'absent' }, 'wallet-1', reader);
      const nonces: number[] = [];
      let failNext = true;
      rig.client.sendRawTransaction = async (args: { serializedTransaction: `0x${string}` }) => {
        nonces.push(parseTransaction(args.serializedTransaction).nonce ?? -1);
        if (failNext) {
          failNext = false;
          state.pending = 1; // it landed; the node just never said so
          throw new Error('request timed out');
        }
        return ('0x' + 'cd'.repeat(32)) as `0x${string}`;
      };

      await expect(rig.engine.executeTransaction(rig.scope, unsignedTx)).rejects.toThrow('request timed out');
      await rig.engine.executeTransaction(rig.scope, unsignedTx);

      expect(nonces).toEqual([0, 1]);
    });
  });

  describe('warmNonce', () => {
    it('initializes a wallet\'s nonce counter but wastes nothing: the very next real execution still gets nonce 0', async () => {
      const { engine, scope } = await buildTestRig();

      await engine.warmNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress });
      const result = await engine.executeTransaction(scope, unsignedTx);

      expect(result.nonce).toBe(0);
    });

    it('calling it twice in a row still leaves the next real execution at nonce 0', async () => {
      const { engine, scope } = await buildTestRig();
      const nonceScope = { chainId: scope.chainId, walletAddress: scope.walletAddress };

      await engine.warmNonce(nonceScope);
      await engine.warmNonce(nonceScope);
      const result = await engine.executeTransaction(scope, unsignedTx);

      expect(result.nonce).toBe(0);
    });

    it('allocates nothing, so a send that starts while a warm-up is in flight still gets nonce 0', async () => {
      const { engine, scope, nonceManager } = await buildTestRig();
      const nonceScope = { chainId: scope.chainId, walletAddress: scope.walletAddress };
      await engine.warmNonce(nonceScope);

      const [, result] = await Promise.all([engine.warmNonce(nonceScope), engine.executeTransaction(scope, unsignedTx)]);

      expect(result.nonce).toBe(0);
      expect(await nonceManager.getNextNonce(nonceScope)).toBe(1);
    });

    it('pays the cold-start chain read during warming, not during the real send right after', async () => {
      let pendingNonceReads = 0;
      const countingReader: ChainNonceReader = {
        async getPendingNonce() {
          pendingNonceReads += 1;
          return 0;
        },
      };
      const { engine, scope } = await buildTestRig({}, 'wallet-1', countingReader);

      await engine.warmNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress });
      expect(pendingNonceReads).toBe(1); // the one-time cold-start read, paid here

      await engine.executeTransaction(scope, unsignedTx);
      expect(pendingNonceReads).toBe(1); // NOT paid again: the counter was already warm
    });

    it('a counter stuck ahead of the chain is pulled back, so the next send is not queued behind sends that never landed', async () => {
      const chainAtSix: ChainNonceReader = { getPendingNonce: async () => 6 };
      const { engine, scope, redis } = await buildTestRig({}, 'wallet-1', chainAtSix);
      // Five sends were counted (6..10) that the chain never got; nothing handed out since.
      await redis.set(`nonce:${scope.chainId}:${scope.walletAddress.toLowerCase()}:next`, '11');

      await engine.warmNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress });
      const result = await engine.executeTransaction(scope, unsignedTx);

      expect(result.nonce).toBe(6);
    });

    it('a warm-up right after a send leaves the counter alone and reads no chain state', async () => {
      let pendingNonceReads = 0;
      const countingReader: ChainNonceReader = {
        async getPendingNonce() {
          pendingNonceReads += 1;
          return 0;
        },
      };
      const { engine, scope } = await buildTestRig({}, 'wallet-1', countingReader);
      await engine.executeTransaction(scope, unsignedTx); // nonce 0, not yet counted by the chain

      await engine.warmNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress });
      expect(pendingNonceReads).toBe(1);
      expect((await engine.executeTransaction(scope, unsignedTx)).nonce).toBe(1);
    });

    it('a chain read that fails during the check leaves the warm-up, and the counter, as they were', async () => {
      let fail = false;
      const flaky: ChainNonceReader = {
        async getPendingNonce() {
          if (fail) throw new Error('rpc down');
          return 0;
        },
      };
      const { engine, scope } = await buildTestRig({}, 'wallet-1', flaky);
      const nonceScope = { chainId: scope.chainId, walletAddress: scope.walletAddress };
      await engine.warmNonce(nonceScope);
      fail = true;

      await expect(engine.warmNonce(nonceScope)).resolves.toBeUndefined();
      fail = false;
      expect((await engine.executeTransaction(scope, unsignedTx)).nonce).toBe(0);
    });
  });

  describe('waitForConfirmation', () => {
    it('reports confirmed for a successful receipt, and hands back the receipt itself', async () => {
      const logs = [{ address: '0xabc', topics: ['0xtopic'], data: '0x' }];
      const { engine } = await buildTestRig({ receiptStatus: 'success', receiptLogs: logs });

      const result = await engine.waitForConfirmation(('0x' + 'aa'.repeat(32)) as `0x${string}`, 5);

      expect(result.status).toBe('confirmed');
      expect(result.hash).toBe('0x' + 'aa'.repeat(32));
      expect(result.nonce).toBe(5); // passed through, not re-derived
      expect(result.receipt.logs).toBe(logs);
    });

    it('reports reverted for a failed receipt', async () => {
      const { engine } = await buildTestRig({ receiptStatus: 'reverted' });

      const result = await engine.waitForConfirmation(('0x' + 'bb'.repeat(32)) as `0x${string}`, 0);

      expect(result.status).toBe('reverted');
    });
  });
});

describe('TransactionEngine.executePrepared (preset gas, signed-mint hot path)', () => {
  const gas = { gas: 300_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 0n };

  it('broadcasts with the supplied gas and never estimates gas or fees', async () => {
    let captured: `0x${string}` | undefined;
    const { engine, scope, client } = await buildTestRig({ captureBroadcast: (tx) => (captured = tx) });

    const result = await engine.executePrepared(scope, unsignedTx, { gas, simulate: true, dryRun: false });

    expect(result).toEqual({ kind: 'broadcast', hash: '0x' + 'ab'.repeat(32), nonce: 0 });
    expect(client.calls.estimateGas).toBe(0);
    expect(client.calls.estimateFeesPerGas).toBe(0);
    expect(client.calls.call).toBe(1);
    const parsed = parseTransaction(captured!);
    expect(parsed.gas).toBe(300_000n);
    expect(parsed.maxFeePerGas).toBe(2_000_000_000n);
  });

  it('reports simulated -> signed -> broadcast in order, with a simulation duration', async () => {
    const { engine, scope } = await buildTestRig();
    const steps: Array<[string, { simulateMs?: number } | undefined]> = [];

    await engine.executePrepared(scope, unsignedTx, { gas, simulate: true, dryRun: false, onStep: (s, m) => steps.push([s, m]) });

    expect(steps.map(([s]) => s)).toEqual(['simulated', 'signed', 'broadcast']);
    expect(typeof steps[0]![1]?.simulateMs).toBe('number');
  });

  it('skips the eth_call entirely when simulation is off', async () => {
    const { engine, scope, client } = await buildTestRig();
    const steps: string[] = [];

    await engine.executePrepared(scope, unsignedTx, { gas, simulate: false, dryRun: false, onStep: (s) => steps.push(s) });

    expect(client.calls.call).toBe(0);
    expect(steps).toEqual(['signed', 'broadcast']);
  });

  it('dry run simulates, then stops: no nonce allocated, no cap reserved, nothing broadcast', async () => {
    const { engine, scope, client, nonceManager, spendingCapGuard } = await buildTestRig();
    const capped = { ...scope, spendCapWei: 1n }; // any real reservation would exceed this

    const result = await engine.executePrepared(capped, unsignedTx, { gas, simulate: true, dryRun: true });

    expect(result).toEqual({ kind: 'dry-run', simulated: true });
    expect(client.calls.call).toBe(1);
    expect(client.calls.sendRawTransaction).toBe(0);
    // The first real allocation afterwards is still nonce 0: the dry run never took one.
    expect(await nonceManager.getNextNonce({ chainId: 1, walletAddress: scope.walletAddress })).toBe(0);
    expect((await spendingCapGuard.reserve('owner-1:1', 1n, 1n)).ok).toBe(true);
  });

  it('dry run still surfaces a simulation revert', async () => {
    const { engine, scope } = await buildTestRig({ callShouldRevert: true });
    await expect(engine.executePrepared(scope, unsignedTx, { gas, simulate: true, dryRun: true })).rejects.toBeInstanceOf(SimulationRevertedError);
  });

  it('honours an emergency stop and the spending cap exactly like executeTransaction, releasing the nonce', async () => {
    const stopped = await buildTestRig();
    await stopped.emergencyStopGuard.triggerGlobalStop('test');
    await expect(stopped.engine.executePrepared(stopped.scope, unsignedTx, { gas, simulate: false, dryRun: false })).rejects.toBeInstanceOf(
      EmergencyStopActiveError,
    );

    const capped = await buildTestRig();
    const err = await capped.engine
      .executePrepared({ ...capped.scope, spendCapWei: 1n }, unsignedTx, { gas, simulate: false, dryRun: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendingCapExceededError);
    expect(capped.client.calls.sendRawTransaction).toBe(0);
    expect(await capped.nonceManager.getNextNonce({ chainId: 1, walletAddress: capped.scope.walletAddress })).toBe(0);
  });

  it('a throwing onStep after broadcast never releases the nonce that was actually used', async () => {
    const { engine, scope, nonceManager } = await buildTestRig();

    const result = await engine.executePrepared(scope, unsignedTx, {
      gas,
      simulate: false,
      dryRun: false,
      onStep: (s) => {
        if (s === 'broadcast') throw new Error('callback bug');
      },
    });

    expect(result.kind).toBe('broadcast');
    expect(await nonceManager.getNextNonce({ chainId: 1, walletAddress: scope.walletAddress })).toBe(1);
  });
});
