import { describe, expect, it } from 'vitest';
import { encodeErrorResult, getAddress, parseEther } from 'viem';
import { SEADROP_ABI } from '@stryx/nft-engine';
import { BroadcastUncertainError, SimulationRevertedError, type PreparedExecutionOptions, type TransactionScope, type UnsignedTransactionRequest } from '@stryx/transaction-engine';
import { OpenSeaSignedMintClient } from '../src/opensea-signed-mint-client.js';
import { InMemorySignedMintRepository } from '../src/signed-mint-repository.js';
import { SignedMintRunner, type SignedMintFlags, type SignedMintJobData } from '../src/signed-mint-runner.js';
import type { ChainServices } from '../src/chain-services.js';
import type { UserId } from '@stryx/wallet-service';
import { CHAIN_ID, FEE_RECIPIENT, NFT, OPENSEA_SIGNER, SIGNER_BOUNDS, fakeHeaderFetch, openSeaCalldataFor, type FakeResponse } from './fakes/signed-mint-fixtures.js';

const OWNER = 'owner-1' as UserId;
const WALLETS = {
  w1: getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8'),
  w2: getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'),
} as const;
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

/** A compressed timeline: T-0 is ~250ms away, calldata requests start 100ms before it. */
const TIMING = { warmupLeadMs: 250, fetchLeadMs: 100, keepAliveIntervalMs: 60, receiptPollMs: 5, receiptTimeoutMs: 2_000, openSeaRequestTimeoutMs: 80, warmupReadTimeoutMs: 500, notActiveSimRetries: 8, notActiveSimRetryMs: 10 };

interface RigOptions {
  enabled?: boolean;
  dryRun?: boolean;
  simulate?: boolean;
  maxSpendWei?: string | null;
  maxPriceWei?: string;
  giveUpMs?: number;
  balances?: Partial<Record<string, bigint>>;
  /** Decides OpenSea's answer per request: default is 409 before T-0, calldata after. */
  openSea?: (minter: `0x${string}`, quantity: number, t0: number, signal?: AbortSignal) => FakeResponse | Promise<FakeResponse>;
  engineThrows?: unknown;
  /** Per call (0-based, across wallets): an error to throw, or undefined to succeed. */
  engineThrowsOn?: (call: number, walletId: string) => unknown;
  claimSend?: boolean;
  /** How long the at-most-once claim takes, as a Redis round trip would. */
  claimDelayMs?: number;
  /** The claim throws for this wallet (Redis failing mid-run). */
  claimThrowsFor?: string;
  aborted?: boolean;
  blockTimestampOffsetMs?: number;
  openSeaStartMs?: (t0: number) => number;
  immediate?: boolean;
  rehearsal?: boolean;
  signingWarmFails?: boolean;
  /** SIGNED_MINT_OVERLAP_MS / SIGNED_MINT_MAX_IN_FLIGHT. */
  overlap?: { intervalMs: number; maxInFlight: number };
  holdKeys?: boolean;
  openSeaConcurrency?: number;
  timing?: Partial<typeof TIMING> & { overlapLeadMs?: number; overlapWindowMs?: number; maxClockShiftMs?: number };
  /** OpenSea's clock relative to ours, via its Date header: +2000 means this server reads 2s behind. */
  openSeaDateOffsetMs?: number;
}

async function rig(opts: RigOptions = {}) {
  const t0 = Date.now() + TIMING.warmupLeadMs;
  const repository = new InMemorySignedMintRepository();
  const engineCalls: Array<{ scope: TransactionScope; tx: UnsignedTransactionRequest; options: PreparedExecutionOptions }> = [];
  const warmed: string[] = [];
  const signingWarmed: string[] = [];
  const signingOpts: Array<{ holdKeyMs?: number } | undefined> = [];
  const released: string[] = [];
  const enqueued: string[] = [];
  const audited: string[] = [];
  const claims: string[] = [];

  const chain = {
    publicClient: {
      getChainId: async () => CHAIN_ID,
      getBlock: async () => ({ timestamp: BigInt(Math.floor((Date.now() + (opts.blockTimestampOffsetMs ?? 0)) / 1000)) }),
      getBlockNumber: async () => 1n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n }),
      getBalance: async ({ address }: { address: string }) => opts.balances?.[address] ?? parseEther('1'),
      waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 99n, gasUsed: 120_000n, effectiveGasPrice: 1_000_000_000n }),
    },
    seaDropReader: {
      getSigners: async () => [OPENSEA_SIGNER.address],
      getSignedMintValidationParams: async () => SIGNER_BOUNDS,
      getAllowedFeeRecipients: async () => [FEE_RECIPIENT],
    },
    transactionEngine: {
      warmNonce: async (scope: { walletAddress: string }) => {
        warmed.push(scope.walletAddress);
      },
      warmSigning: async (walletId: string, o?: { holdKeyMs?: number }) => {
        signingWarmed.push(walletId);
        signingOpts.push(o);
        if (opts.signingWarmFails) throw new Error('KMS unreachable');
      },
      releaseSigning: (walletId: string) => {
        released.push(walletId);
      },
      executePrepared: async (scope: TransactionScope, tx: UnsignedTransactionRequest, options: PreparedExecutionOptions) => {
        engineCalls.push({ scope, tx, options });
        if (opts.engineThrows) throw opts.engineThrows;
        const scripted = opts.engineThrowsOn?.(engineCalls.length - 1, scope.walletId);
        if (scripted) throw scripted;
        if (options.simulate) options.onStep?.('simulated', { simulateMs: 3 });
        if (options.dryRun) return { kind: 'dry-run', simulated: options.simulate };
        options.onStep?.('signed');
        options.onStep?.('broadcast');
        return { kind: 'broadcast', hash: `0x${'ab'.repeat(32)}`, nonce: 7 };
      },
    },
  } as unknown as ChainServices;

  const { fetchImpl, requests } = fakeHeaderFetch(async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as { minter: `0x${string}`; quantity: number };
      if (opts.openSea) return opts.openSea(body.minter, body.quantity, t0, (init as { signal?: AbortSignal }).signal);
      if (Date.now() < t0) return { status: 409, body: { errors: ['Drop is not currently active for minting'] } };
      return { status: 200, body: { transaction: { data: await openSeaCalldataFor(body.minter, body.quantity) } } };
    }
    const start = opts.openSeaStartMs ? opts.openSeaStartMs(t0) : t0;
    return {
      status: 200,
      headers: { Date: new Date(Date.now() + (opts.openSeaDateOffsetMs ?? 0)).toUTCString() },
      body: { stages: [{ uuid: 'stage-1', stage_type: 'signed_presale', label: 'FCFS', start_time: new Date(start).toISOString() }] },
    };
  });

  const flags: SignedMintFlags = {
    claimSend: async (jobId, walletId) => {
      claims.push(walletId);
      if (opts.claimThrowsFor === walletId) throw new Error('redis down');
      if (opts.claimDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.claimDelayMs));
      return opts.claimSend ?? true;
    },
    isAborted: async () => opts.aborted ?? false,
    abort: async () => undefined,
  };

  const runner = new SignedMintRunner({
    walletService: {
      getWalletSummary: async (_owner: UserId, id: string) => ({ id, address: WALLETS[id as keyof typeof WALLETS], status: 'ACTIVE' }),
    } as never,
    chainServices: new Map([[CHAIN_ID, chain]]),
    openSea: new OpenSeaSignedMintClient(fetchImpl, 'key'),
    repository,
    flags,
    spendCapResolver: { resolve: async () => null, walletCap: () => null },
    confirmationWatcher: { enqueue: async (job) => void enqueued.push(job.hash) },
    auditLogService: { record: async (e) => void audited.push(e.action) },
    executionEnabled: opts.enabled ?? true,
    openSeaConcurrency: opts.openSeaConcurrency ?? 4,
    ...(opts.overlap ? { overlap: opts.overlap } : {}),
    ...(opts.holdKeys !== undefined ? { holdKeys: opts.holdKeys } : {}),
    logger: silentLogger,
    timing: { ...TIMING, ...opts.timing },
  });

  const data: SignedMintJobData = {
    ownerId: OWNER,
    chainId: CHAIN_ID,
    nftContract: NFT,
    slug: 'kid-story',
    stageUuid: 'stage-1',
    stageLabel: 'FCFS',
    startMs: t0,
    maxPriceWei: opts.maxPriceWei ?? parseEther('0.001').toString(),
    wallets: [
      { walletId: 'w1', quantity: 2 },
      { walletId: 'w2', quantity: 1 },
    ],
    settings: {
      simulate: opts.simulate ?? true,
      dryRun: opts.dryRun ?? false,
      maxSpendWei: opts.maxSpendWei ?? null,
      retryIntervalMs: 20,
      giveUpMs: opts.giveUpMs ?? 1_000,
    },
    rehearsal: opts.rehearsal ?? false,
    ...(opts.immediate ? { immediate: true } : {}),
  };

  const run = () => runner.run('job-1', data);
  const attempt = (walletId: string) => repository.attempts.get(`job-1:${walletId}`)!;
  const mintRequests = () => requests.filter((r) => r.method === 'POST');
  const dropReads = () => requests.filter((r) => r.method !== 'POST');
  return { run, attempt, repository, engineCalls, warmed, signingWarmed, signingOpts, released, enqueued, audited, claims, mintRequests, dropReads, t0 };
}

describe('SignedMintRunner', () => {
  it('runs the full timeline: warm-up, retries while not active, validates, sends with preset gas, confirms, times every step', async () => {
    const r = await rig();
    const result = await r.run();

    expect(result).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect(r.warmed.sort()).toEqual([WALLETS.w1, WALLETS.w2].sort());

    const a = r.attempt('w1');
    expect(a.status).toBe('confirmed');
    expect(a.txHash).toBe(`0x${'ab'.repeat(32)}`);
    expect(a.notActiveCount).toBeGreaterThan(0);
    expect(a.calldataMs).not.toBeNull();
    expect(a.simulateDurationMs).toBe(3);
    const order = [a.calldataMs, a.simulatedMs, a.signedMs, a.broadcastMs, a.confirmedMs] as number[];
    expect(order.every((v) => typeof v === 'number')).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(a.gasUsed).toBe('120000');
    expect(a.valueWei).toBe(parseEther('0.002').toString());

    // Our own rebuilt tx, the exact quantity, preset gas (2 tokens = base + one extra), padded fees.
    const call = r.engineCalls.find((c) => c.scope.walletId === 'w1')!;
    expect(call.options.gas).toEqual({ gas: 440_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 0n });
    expect(call.options.simulate).toBe(true);
    expect(call.options.dryRun).toBe(false);
    expect(call.tx.value).toBe(parseEther('0.002'));

    // Nothing asked before the fetch lead (T-1.5s in production, compressed here).
    expect(Math.min(...r.mintRequests().map((q) => q.at))).toBeGreaterThanOrEqual(r.t0 - TIMING.fetchLeadMs - 5);
    // Each wallet asked with its OWN quantity.
    expect(new Set(r.mintRequests().map((q) => JSON.stringify(q.body)))).toEqual(
      new Set([JSON.stringify({ minter: WALLETS.w1, quantity: 2 }), JSON.stringify({ minter: WALLETS.w2, quantity: 1 })]),
    );
    expect(r.enqueued).toHaveLength(2);
    expect(r.audited).toEqual(['mint.signed', 'mint.signed']);

    const run = await r.repository.getRun('job-1');
    expect(run?.status).toBe('finished');
    expect(run?.clockSkewed).toBe(false);
    expect(run?.clockSummary).toMatch(/opensea/);
  });

  it('warm-up gets each wallet ready to sign (key record + KMS connection), in the background', async () => {
    const r = await rig();
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect([...r.signingWarmed].sort()).toEqual(['w1', 'w2']);
  });

  it('a dry run never touches keys: no signing warm-up', async () => {
    const r = await rig({ dryRun: true });
    await r.run();
    expect(r.signingWarmed).toEqual([]);
  });

  it('a failed signing warm-up (KMS unreachable) skips nobody: both wallets still mint', async () => {
    const r = await rig({ signingWarmFails: true });
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
  });

  it('warm-up opens one OpenSea connection per wallet that will ask in parallel, not just one', async () => {
    const r = await rig();
    await r.run();
    // 1 read for the start time and clock, then at least one per wallet (2) to warm connections.
    expect(r.dropReads().length).toBeGreaterThanOrEqual(3);
  });

  it('kill switch off: every wallet skipped, OpenSea never asked, nothing sent', async () => {
    const r = await rig({ enabled: false });
    expect(await r.run()).toEqual({ status: 'disabled' });
    expect(r.attempt('w1')).toMatchObject({ status: 'skipped', reason: 'execution_disabled' });
    expect(r.mintRequests()).toHaveLength(0);
    expect(r.engineCalls).toHaveLength(0);
  });

  it('dry run: validates and simulates, never claims a send, never broadcasts', async () => {
    const r = await rig({ dryRun: true });
    expect(await r.run()).toEqual({ status: 'finished', counts: { dry_run_ok: 2 } });
    expect(r.attempt('w1')).toMatchObject({ status: 'dry_run_ok', txHash: null });
    expect(r.attempt('w1').simulatedMs).not.toBeNull();
    expect(r.engineCalls.every((c) => c.options.dryRun)).toBe(true);
    expect(r.claims).toHaveLength(0);
    expect(r.enqueued).toHaveLength(0);
  });

  it('an ineligible wallet fails with OpenSea\'s plain reason after ONE request; the other wallet still mints', async () => {
    const r = await rig({
      openSea: async (minter, quantity, t0) => {
        if (minter === WALLETS.w2) return { status: 422, body: { errors: ['Wallet is not on the allowlist for this stage'] } };
        if (Date.now() < t0) return { status: 409, body: { errors: ['Drop is not currently active for minting'] } };
        return { status: 200, body: { transaction: { data: await openSeaCalldataFor(minter, quantity) } } };
      },
    });
    await r.run();
    expect(r.attempt('w2')).toMatchObject({ status: 'failed', reason: 'not_eligible', detail: 'Wallet is not on the allowlist for this stage' });
    expect(r.mintRequests().filter((q) => (q.body as { minter: string }).minter === WALLETS.w2)).toHaveLength(1);
    expect(r.attempt('w1').status).toBe('confirmed');
  });

  // Seen live 2026-09-28: while GTD runs, OpenSea answers an FCFS wallet with a 422 naming GTD.
  const GTD_ACTIVE = "Wallet is not eligible for the active drop stage 'GTD' (signed_presale): the wallet is not on this stage's allowlist.";

  it('a 422 naming a different active stage is "not open yet": keeps asking and mints once this stage opens', async () => {
    const r = await rig({
      openSea: async (minter, quantity, t0) => {
        if (Date.now() < t0) return { status: 422, body: { errors: [GTD_ACTIVE] } };
        return { status: 200, body: { transaction: { data: await openSeaCalldataFor(minter, quantity) } } };
      },
    });
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect(r.attempt('w1').notActiveCount).toBeGreaterThan(0);
    expect(r.mintRequests().filter((q) => (q.body as { minter: string }).minter === WALLETS.w1).length).toBeGreaterThan(1);
  });

  it('gives up with the named active stage in the detail if that stage never hands over', async () => {
    const variant = "wallet is not eligible for the active drop stage. 'GTD' (signed_presale): the wallet is not on this stage's allowlist.";
    const r = await rig({ giveUpMs: 150, openSea: () => ({ status: 422, body: { errors: [variant] } }) });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'gave_up' });
    expect(r.attempt('w1').detail).toMatch(/active stage was still "GTD", not "FCFS"/);
  });

  it('a rehearsal cannot outwait another active stage: ends at once with a reason that says why', async () => {
    const r = await rig({ rehearsal: true, dryRun: true, openSea: () => ({ status: 422, body: { errors: [GTD_ACTIVE] } }) });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'other_stage_active' });
    expect(r.attempt('w1').detail).toMatch(/cannot get calldata until "FCFS" opens/);
    expect(r.mintRequests().filter((q) => (q.body as { minter: string }).minter === WALLETS.w1)).toHaveLength(1);
    expect(r.engineCalls).toHaveLength(0);
  });

  it('a 422 naming THIS stage is a final "not eligible", after one request', async () => {
    const own = "Wallet is not eligible for the active drop stage 'fcfs' (signed_presale): the wallet is not on this stage's allowlist.";
    const r = await rig({ openSea: () => ({ status: 422, body: { errors: [own] } }) });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'not_eligible', detail: own });
    expect(r.mintRequests().filter((q) => (q.body as { minter: string }).minter === WALLETS.w1)).toHaveLength(1);
  });

  it('gives up after the configured window if OpenSea never opens, and says so', async () => {
    const r = await rig({ giveUpMs: 150, openSea: () => ({ status: 409, body: { errors: ['Drop is not currently active for minting'] } }) });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'gave_up' });
    expect(r.attempt('w1').detail).toMatch(/not currently active/);
    expect(r.engineCalls).toHaveLength(0);
  });

  it('backs off on 429 (honouring Retry-After) and still gets through', async () => {
    let limited = 0;
    const r = await rig({
      openSea: async (minter, quantity) => {
        if (limited < 1) {
          limited++;
          return { status: 429, headers: { 'Retry-After': '0' } };
        }
        return { status: 200, body: { transaction: { data: await openSeaCalldataFor(minter, quantity) } } };
      },
    });
    await r.run();
    const counts = [r.attempt('w1').rateLimitedCount, r.attempt('w2').rateLimitedCount];
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(r.attempt('w1').status).toBe('confirmed');
    expect(r.attempt('w2').status).toBe('confirmed');
  });

  it('warm-up skips only the wallet that cannot afford the mint', async () => {
    const r = await rig({ balances: { [WALLETS.w2]: 1n } });
    await r.run();
    expect(r.attempt('w2')).toMatchObject({ status: 'skipped', reason: 'insufficient_funds' });
    expect(r.attempt('w1').status).toBe('confirmed');
    expect(r.mintRequests().every((q) => (q.body as { minter: string }).minter === WALLETS.w1)).toBe(true);
  });

  it('refuses a signed price above what the operator accepted, before anything is sent', async () => {
    const r = await rig({ maxPriceWei: '1' });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'price_above_expected' });
    expect(r.engineCalls).toHaveLength(0);
  });

  it('enforces the per-job spend limit across wallets', async () => {
    const r = await rig({ maxSpendWei: parseEther('0.002').toString() });
    await r.run();
    const statuses = [r.attempt('w1').status, r.attempt('w2').status].sort();
    // w1 (0.002) fits exactly; w2 (0.001) would exceed. If w2 happened to go first, w1 is the one refused.
    expect(statuses).toContain('skipped');
    const skipped = [r.attempt('w1'), r.attempt('w2')].find((a) => a.status === 'skipped')!;
    expect(skipped.reason).toBe('job_spend_limit');
  });

  it('the spend limit holds when wallets reach it together and the claim takes a round trip', async () => {
    // Either wallet alone fits 0.002; both together (0.003) do not.
    const r = await rig({ maxSpendWei: parseEther('0.002').toString(), claimDelayMs: 40 });
    await r.run();
    const attempts = [r.attempt('w1'), r.attempt('w2')];
    expect(attempts.filter((a) => a.status === 'skipped' && a.reason === 'job_spend_limit')).toHaveLength(1);
    expect(r.engineCalls).toHaveLength(1);
  });

  it('a send the chain could not confirm either way is followed by its hash, not written off as failed', async () => {
    const hash = `0x${'cd'.repeat(32)}` as const;
    const r = await rig({ engineThrows: new BroadcastUncertainError({} as never, hash, 3, new Error('timeout')) });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'confirmed', txHash: hash, nonce: 3 });
    expect(r.enqueued).toContain(hash);
  });

  it('a database that fails every status write costs the status lines, not the mint', async () => {
    const r = await rig();
    r.repository.updateRun = async () => {
      throw new Error('database down');
    };
    r.repository.upsertRun = async () => {
      throw new Error('database down');
    };

    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect(r.engineCalls).toHaveLength(2);
  });

  it('one wallet hitting an unexpected error ends that wallet only: the other still mints', async () => {
    const r = await rig({ claimThrowsFor: 'w1' });
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 1, failed: 1 } });
    expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'internal_error' });
    expect(r.attempt('w2').status).toBe('confirmed');
  });

  it('never sends for a wallet already sent in an earlier run of the same job', async () => {
    const r = await rig({ claimSend: false });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'skipped', reason: 'already_sent' });
    expect(r.engineCalls).toHaveLength(0);
  });

  it('an abort flag set before warm-up ends stops every wallet', async () => {
    const r = await rig({ aborted: true });
    expect(await r.run()).toEqual({ status: 'aborted' });
    expect(r.attempt('w1')).toMatchObject({ status: 'skipped', reason: 'aborted' });
    expect(r.mintRequests()).toHaveLength(0);
  });

  it('records a simulation revert as that wallet\'s failure, decoded', async () => {
    const r = await rig({ engineThrows: new SimulationRevertedError({ chainId: CHAIN_ID, walletId: 'w1', walletAddress: WALLETS.w1, ownerId: OWNER, spendCapWei: null }, new Error('execution reverted')) });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'simulation_reverted' });
  });

  it('does NOT warn just because the latest block is old (a quiet chain makes no empty blocks)', async () => {
    const r = await rig({ blockTimestampOffsetMs: -5_000 });
    await r.run();
    expect((await r.repository.getRun('job-1'))?.clockSkewed).toBe(false);
  });

  it('warns loudly when the server clock is behind the chain by more than 1s', async () => {
    const r = await rig({ blockTimestampOffsetMs: 5_000 });
    await r.run();
    const run = await r.repository.getRun('job-1');
    expect(run?.clockSkewed).toBe(true);
    expect(run?.notes).toMatch(/WARNING: clock skew over 1s/);
  });

  it('returns "moved" when OpenSea pushed the start well past warm-up', async () => {
    const r = await rig({ openSeaStartMs: (t0) => t0 + 60_000 });
    const result = await r.run();
    expect(result.status).toBe('moved');
    expect(r.mintRequests()).toHaveLength(0);
  });

  it('abandons a hung OpenSea request after its timeout and asks again', async () => {
    let hung = 0;
    const r = await rig({
      openSea: async (minter, quantity, _t0, signal) => {
        if (minter === WALLETS.w1 && hung === 0) {
          hung++;
          return new Promise<FakeResponse>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
        }
        return { status: 200, body: { transaction: { data: await openSeaCalldataFor(minter, quantity) } } };
      },
    });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'confirmed', errorCount: 1 });
  });

  it('refuses calldata OpenSea aims at a contract other than SeaDrop', async () => {
    const r = await rig({
      openSea: async (minter, quantity) => ({
        status: 200,
        body: { transaction: { to: '0x000000000000000000000000000000000000dEaD', data: await openSeaCalldataFor(minter, quantity) } },
      }),
    });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'unexpected_target' });
    expect(r.engineCalls).toHaveLength(0);
  });

  it('"mint now" on a live stage keeps its own T-0: OpenSea\'s start, long past, is not re-read (it would mean giving up at once)', async () => {
    const r = await rig({
      immediate: true,
      openSeaStartMs: (t0) => t0 - 3_600_000, // the stage opened an hour ago
      openSea: async (minter, quantity) => ({ status: 200, body: { transaction: { data: await openSeaCalldataFor(minter, quantity) } } }),
    });
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect((await r.repository.getRun('job-1'))?.t0.getTime()).toBe(r.t0);
  });

  it('without "mint now", a stage OpenSea says started long ago moves T-0 there, and the job gives up rather than minting late', async () => {
    const r = await rig({
      openSeaStartMs: (t0) => t0 - 3_600_000,
      openSea: async (minter, quantity) => ({ status: 200, body: { transaction: { data: await openSeaCalldataFor(minter, quantity) } } }),
    });
    await r.run();
    expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'gave_up' });
    expect(r.engineCalls).toHaveLength(0);
  });

  it('OpenSea calldata with a trailing tag still mints: our encoding is sent, and the difference is recorded', async () => {
    const r = await rig({
      openSea: async (minter, quantity) => ({ status: 200, body: { transaction: { data: `${await openSeaCalldataFor(minter, quantity)}1d4da48b` } } }),
    });
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect(r.engineCalls[0]!.tx.data.endsWith('1d4da48b')).toBe(false);
    expect(r.attempt('w1').detail).toMatch(/extra trailing bytes/);
  });

  describe('a NotActive simulation right after calldata (latest block older than the stage start)', () => {
    const scope = { chainId: CHAIN_ID, walletId: 'w1', walletAddress: WALLETS.w1, ownerId: OWNER, spendCapWei: null };
    const revert = (errorName: 'NotActive' | 'MintQuantityCannotBeZero') => {
      const data = encodeErrorResult(
        errorName === 'NotActive' ? { abi: SEADROP_ABI, errorName, args: [1n, 2n, 3n] } : { abi: SEADROP_ABI, errorName },
      );
      const cause = Object.assign(new Error('execution reverted'), { walk: (fn: (e: unknown) => boolean) => (fn({ data }) ? { data } : undefined) });
      return new SimulationRevertedError(scope, cause);
    };
    const onlyW1 = (n: number) => {
      let w1Calls = 0;
      return (_call: number, walletId: string) => (walletId === 'w1' && w1Calls++ < n ? revert('NotActive') : undefined);
    };

    it('is retried, and the mint goes ahead once it passes (the retries are noted)', async () => {
      const r = await rig({ engineThrowsOn: onlyW1(2) });
      await r.run();
      expect(r.attempt('w1').status).toBe('confirmed');
      expect(r.engineCalls.filter((c) => c.scope.walletId === 'w1')).toHaveLength(3);
      expect(r.attempt('w1').detail).toMatch(/NotActive 2x before passing/);
    });

    it('still fails the wallet once the retry budget is spent', async () => {
      const r = await rig({ engineThrowsOn: onlyW1(100) });
      await r.run();
      expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'simulation_reverted' });
      expect(r.attempt('w1').detail).toMatch(/retried 8x on NotActive/);
      expect(r.engineCalls.filter((c) => c.scope.walletId === 'w1')).toHaveLength(9);
      expect(r.attempt('w2').status).toBe('confirmed');
    });

    it('any other revert is not retried', async () => {
      const r = await rig({ engineThrowsOn: (_c, walletId) => (walletId === 'w1' ? revert('MintQuantityCannotBeZero') : undefined) });
      await r.run();
      expect(r.attempt('w1')).toMatchObject({ status: 'failed', reason: 'simulation_reverted' });
      expect(r.engineCalls.filter((c) => c.scope.walletId === 'w1')).toHaveLength(1);
    });
  });
});

/** An OpenSea whose every answer takes `rttMs`, that opens at T-0, and that records each wallet's requests in flight. */
function slowOpenSea(rttMs: number, opts: { rateLimitOnce?: boolean } = {}) {
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  /** Counting only requests that STARTED after the 429 was answered. */
  const inFlightAfter429 = new Map<string, number>();
  const peakAfter429 = new Map<string, number>();
  let rateLimitedAt: number | null = null;
  let answered429 = false;
  const respond = async (minter: `0x${string}`, quantity: number, t0: number): Promise<FakeResponse> => {
    const sentAt = Date.now();
    const startedAfter429 = rateLimitedAt !== null;
    const n = (inFlight.get(minter) ?? 0) + 1;
    inFlight.set(minter, n);
    peak.set(minter, Math.max(peak.get(minter) ?? 0, n));
    if (startedAfter429) {
      const later = (inFlightAfter429.get(minter) ?? 0) + 1;
      inFlightAfter429.set(minter, later);
      peakAfter429.set(minter, Math.max(peakAfter429.get(minter) ?? 0, later));
    }
    await new Promise((resolve) => setTimeout(resolve, rttMs));
    inFlight.set(minter, (inFlight.get(minter) ?? 1) - 1);
    if (startedAfter429) inFlightAfter429.set(minter, (inFlightAfter429.get(minter) ?? 1) - 1);
    if (opts.rateLimitOnce && !answered429 && n > 1) {
      answered429 = true;
      rateLimitedAt = Date.now();
      return { status: 429, body: { errors: ['Too many requests'] } };
    }
    if (sentAt < t0) return { status: 409, body: { errors: ['Drop is not currently active for minting'] } };
    return { status: 200, body: { transaction: { data: await openSeaCalldataFor(minter, quantity) } } };
  };
  return { respond, peak, peakAfter429 };
}

describe('SignedMintRunner: overlapping calldata requests', () => {
  const overlap = { intervalMs: 15, maxInFlight: 3 };
  const timing = { openSeaRequestTimeoutMs: 400, overlapLeadMs: 80, overlapWindowMs: 1_000 };

  it('without overlap, a wallet never has more than one request out', async () => {
    const os = slowOpenSea(40);
    const r = await rig({ openSea: os.respond, timing });
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect([...os.peak.values()]).toEqual([1, 1]);
  });

  it('with overlap, each wallet has several requests out around T-0, uses exactly one answer, and sends once', async () => {
    const os = slowOpenSea(40);
    const r = await rig({ openSea: os.respond, overlap, openSeaConcurrency: 8, timing });

    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect(os.peak.get(WALLETS.w1)).toBe(3);
    expect(os.peak.get(WALLETS.w2)).toBe(3);
    expect(r.engineCalls.map((c) => c.scope.walletId).sort()).toEqual(['w1', 'w2']); // one send per wallet, however many answers came back
    expect(r.claims.sort()).toEqual(['w1', 'w2']);
    const a = r.attempt('w1');
    expect(a.requestCount).toBeGreaterThan(a.notActiveCount);
    expect(a.requestCount).toBeGreaterThanOrEqual(3);
  });

  it('the answer that wins was asked for within moments of the opening, not a whole round trip later', async () => {
    const os = slowOpenSea(60);
    const r = await rig({ openSea: os.respond, overlap, openSeaConcurrency: 8, timing });
    await r.run();
    // With answers taking 60ms, one-at-a-time asking (60ms + the 20ms pause) can first ask as late as
    // 80ms after the opening.
    const firstAfterOpen = Math.min(...r.mintRequests().filter((q) => q.at >= r.t0).map((q) => q.at - r.t0));
    expect(firstAfterOpen).toBeLessThan(45);
    expect(r.attempt('w1').calldataMs!).toBeLessThan(60 + 45 + 40);
  });

  it('the job-wide cap still holds: two wallets share four slots', async () => {
    const os = slowOpenSea(40);
    const r = await rig({ openSea: os.respond, overlap, openSeaConcurrency: 4, timing });
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect((os.peak.get(WALLETS.w1) ?? 0) + (os.peak.get(WALLETS.w2) ?? 0)).toBeLessThanOrEqual(6);
    expect(Math.max(...os.peak.values())).toBeLessThanOrEqual(3);
  });

  it('a rate limit switches every wallet back to one request at a time for the rest of the job', async () => {
    const os = slowOpenSea(40, { rateLimitOnce: true });
    const r = await rig({ openSea: os.respond, overlap, openSeaConcurrency: 8, timing, giveUpMs: 3_000 });

    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect(r.attempt('w1').rateLimitedCount + r.attempt('w2').rateLimitedCount).toBe(1);
    // Among the requests started after the 429, no wallet ever has two out at once.
    expect(os.peakAfter429.size).toBeGreaterThan(0);
    for (const n of os.peakAfter429.values()) expect(n).toBe(1);
    expect(r.repository.runs.get('job-1')!.notes).toContain('overlapping requests: every 15ms, up to 3 per wallet');
  });

  it('"mint now" and rehearsals do not overlap: there is no opening to catch', async () => {
    const os = slowOpenSea(30);
    const now = await rig({ openSea: async (m, q) => os.respond(m, q, 0), overlap, openSeaConcurrency: 8, timing, immediate: true });
    expect(await now.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    expect([...os.peak.values()]).toEqual([1, 1]);
    expect(now.repository.runs.get('job-1')!.notes).toContain('overlapping requests: off');
  });
});

describe('SignedMintRunner: a clock that reads behind', () => {
  it('asks earlier by the amount it is behind, capped, and says so', async () => {
    const r = await rig({ openSeaDateOffsetMs: 4_000, timing: { maxClockShiftMs: 100 } });
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    const first = Math.min(...r.mintRequests().map((q) => q.at));
    expect(first).toBeLessThan(r.t0 - TIMING.fetchLeadMs - 50); // the usual start is T-0 minus 100ms
    expect(r.repository.runs.get('job-1')!.notes).toContain('clock reads about 100ms behind: asking that much earlier');
  });

  it('a clock that reads ahead, or an old latest block, moves nothing', async () => {
    const r = await rig({ openSeaDateOffsetMs: -4_000, blockTimestampOffsetMs: -9_000 });
    await r.run();
    const first = Math.min(...r.mintRequests().map((q) => q.at));
    expect(first).toBeGreaterThanOrEqual(r.t0 - TIMING.fetchLeadMs - 15);
    expect(r.repository.runs.get('job-1')!.notes).not.toContain('asking that much earlier');
  });
});

describe('SignedMintRunner: keys held from warm-up (SIGNED_MINT_HOLD_KEYS)', () => {
  it('off by default: the warm-up asks for no hold, and nothing is released', async () => {
    const r = await rig();
    await r.run();
    expect(r.signingOpts.every((o) => !o?.holdKeyMs)).toBe(true);
    expect(r.released).toEqual([]);
    expect(r.repository.runs.get('job-1')!.notes).toContain('keys held from warm-up: no');
  });

  it('on: each wallet\'s key is held until the job could give up, and released when the wallet is done', async () => {
    const r = await rig({ holdKeys: true, giveUpMs: 1_000 });
    expect(await r.run()).toEqual({ status: 'finished', counts: { confirmed: 2 } });
    for (const o of r.signingOpts) {
      expect(o?.holdKeyMs).toBeGreaterThan(1_000 + 10_000);
      expect(o?.holdKeyMs).toBeLessThan(1_000 + 10_000 + TIMING.warmupLeadMs + 50);
    }
    expect(new Set(r.released)).toEqual(new Set(['w1', 'w2']));
    expect(r.repository.runs.get('job-1')!.notes).toContain('keys held from warm-up: yes');
  });

  it('released when a wallet is refused, when sending fails, and when the job is cancelled at warm-up', async () => {
    const refused = await rig({ holdKeys: true, openSea: () => ({ status: 422, body: { errors: ['Wallet is not eligible for this stage'] } }) });
    await refused.run();
    expect(new Set(refused.released)).toEqual(new Set(['w1', 'w2']));

    const sendFails = await rig({ holdKeys: true, engineThrows: new Error('boom') });
    await sendFails.run();
    expect(new Set(sendFails.released)).toEqual(new Set(['w1', 'w2']));

    const cancelled = await rig({ holdKeys: true, aborted: true });
    expect(await cancelled.run()).toEqual({ status: 'aborted' });
    expect(new Set(cancelled.released)).toEqual(new Set(['w1', 'w2']));
  });

  it('a dry run never touches keys, held or not', async () => {
    const r = await rig({ holdKeys: true, dryRun: true });
    await r.run();
    expect(r.signingWarmed).toEqual([]);
    expect(r.released).toEqual([]);
  });
});
