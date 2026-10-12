import { describe, expect, it } from 'vitest';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService, type UserId } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { SimulationRevertedError, RpcUnavailableError } from '@stryx/transaction-engine';
import { buildApp } from '../src/app.js';
import { MintExecutionService } from '../src/mint-execution.service.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import type { ChainServices } from '../src/chain-services.js';
import { InMemoryMintEventRepository, safeNote, type MintEventRepository } from '../src/mint-event-log.js';
import { MintEventSettler, type ReceiptReader } from '../src/mint-event-settler.js';
import { copySignedRunToMintLog } from '../src/signed-mint-history.js';
import { InMemorySignedMintRepository } from '../src/signed-mint-repository.js';
import { dispatchScheduledMint } from '../src/mint-scheduler.js';
import { FakeOpenSeaDropClient } from './fakes/fake-opensea-drop-client.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';
import { RedisSessionStore } from '../src/session-store.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';

const CHAIN = 46630;
const NFT = '0x1234567890123456789012345678901234567890' as const;
const OWNER = 'owner-1' as UserId;
const HASH = ('0x' + '11'.repeat(32)) as `0x${string}`;

type EngineMode = { kind: 'ok' } | { kind: 'throw-before-sign'; error: Error } | { kind: 'throw-after-sign'; error: Error };

async function rig(opts: { engine?: EngineMode; active?: boolean; repository?: MintEventRepository } = {}) {
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId);
  const wallet = await walletService.createWallet({ tier: 'HOT' }, OWNER);
  const repository = opts.repository ?? new InMemoryMintEventRepository();
  const order: string[] = [];
  const engine = opts.engine ?? { kind: 'ok' };
  const chain = {
    seaDropReader: {
      getPublicDrop: async () => ({ mintPrice: 5_000n, startTime: 1, endTime: 9_999_999_999, maxTotalMintableByWallet: 5, feeBps: 500, restrictFeeRecipients: false }),
      isPublicStageActive: async () => opts.active ?? true,
      getAllowedFeeRecipients: async () => ['0x0000a26b00c1f0df003000390027140000faa719'],
    },
    transactionEngine: {
      executeTransaction: async (_scope: unknown, _tx: unknown, options: { onSigned?: (s: { hash: `0x${string}`; nonce: number }) => Promise<void> }) => {
        order.push('engine');
        if (engine.kind === 'throw-before-sign') throw engine.error;
        // Like the real engine: bookkeeping that fails does not stop a signed mint.
        await options.onSigned?.({ hash: HASH, nonce: 7 }).catch(() => undefined);
        order.push('send');
        if (engine.kind === 'throw-after-sign') throw engine.error;
        return { hash: HASH, nonce: 7, status: 'broadcast' };
      },
    },
    publicClient: {},
  } as unknown as ChainServices;
  const service = new MintExecutionService(walletService, new Map([[CHAIN, chain]]), new InMemoryAllowListStore(), new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver(), undefined, { repository, logger: noopLogger });
  return { service, repository, walletId: wallet.id, walletAddress: wallet.address, walletService, order };
}

const mint = (walletId: string, extra: Record<string, unknown> = {}) => ({ ownerId: OWNER, walletId, nftContract: NFT, chainId: CHAIN, quantity: 2, ...extra });
const only = async (repository: MintEventRepository) => {
  const rows = await repository.listForOwner(OWNER, { limit: 10 });
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe('mint log: every attempt is on record', () => {
  it('a sent mint: recorded before signing, hash on record before the send, then PENDING with its broadcast time', async () => {
    const r = await rig();
    const repo = r.repository as InMemoryMintEventRepository;
    const statusAtSend: string[] = [];
    const original = repo.update.bind(repo);
    repo.update = async (id, patch) => {
      await original(id, patch);
      statusAtSend.push(`${patch.status ?? '-'}:${r.order.join('>')}`);
    };
    const outcome = await r.service.executePublicMint(mint(r.walletId, { source: 'MANUAL' }));
    expect(outcome.ok).toBe(true);
    expect(statusAtSend[0]).toBe('PENDING:engine'); // the hash was written before 'send'
    const row = await only(r.repository);
    expect(row).toMatchObject({ status: 'PENDING', txHash: HASH, nonce: 7, source: 'MANUAL', kind: 'PUBLIC', quantity: 2, valueWei: '10000', walletAddress: r.walletAddress, contractAddress: NFT, chainId: CHAIN });
    expect(row.broadcastAt).toBeInstanceOf(Date);
  });

  it('if the attempt cannot be recorded, nothing is signed or sent', async () => {
    const repository = new InMemoryMintEventRepository();
    repository.insert = async () => {
      throw new Error('database down');
    };
    const r = await rig({ repository });
    const outcome = await r.service.executePublicMint(mint(r.walletId));
    expect(outcome).toMatchObject({ ok: false, reason: 'history_unavailable' });
    expect(r.order).toEqual([]); // the engine was never called
  });

  it('a refusal before signing is on record as BLOCKED with its reason', async () => {
    const r = await rig({ active: false });
    await r.service.executePublicMint(mint(r.walletId));
    expect(await only(r.repository)).toMatchObject({ status: 'BLOCKED', failureReason: 'no_active_public_stage', txHash: null });
  });

  it('a failed simulation is BLOCKED, and its note is short and carries no URL', async () => {
    const error = new SimulationRevertedError({ chainId: CHAIN, walletId: 'w', walletAddress: '0x' + '1'.repeat(40), ownerId: OWNER, spendCapWei: null }, 'reverted via https://rpc.example.com/v2/SECRETKEY ' + 'x'.repeat(400));
    const r = await rig({ engine: { kind: 'throw-before-sign', error } });
    await r.service.executePublicMint(mint(r.walletId));
    const row = await only(r.repository);
    expect(row).toMatchObject({ status: 'BLOCKED', failureReason: 'simulation_reverted' });
    expect(row.failureNote!.length).toBeLessThanOrEqual(200);
    expect(row.failureNote).not.toContain('SECRETKEY');
  });

  it('signed but the send failed: stays PENDING with its hash (the chain decides, not a guess)', async () => {
    const error = new RpcUnavailableError({ chainId: CHAIN, walletId: 'w', walletAddress: '0x' + '1'.repeat(40), ownerId: OWNER, spendCapWei: null }, 'broadcast', new Error('timeout'));
    const r = await rig({ engine: { kind: 'throw-after-sign', error } });
    const outcome = await r.service.executePublicMint(mint(r.walletId));
    expect(outcome.ok).toBe(false);
    expect(await only(r.repository)).toMatchObject({ status: 'PENDING', txHash: HASH });
  });

  const failFirstHashWrite = (repo: InMemoryMintEventRepository) => {
    const original = repo.update.bind(repo);
    let failed = false;
    repo.update = async (id, patch) => {
      if (!failed && patch.txHash) {
        failed = true;
        throw new Error('database blip');
      }
      await original(id, patch);
    };
  };

  it('a sent mint whose hash could not be saved at signing has it saved afterwards, not left to be marked interrupted', async () => {
    const repository = new InMemoryMintEventRepository();
    failFirstHashWrite(repository);
    const r = await rig({ repository });
    const outcome = await r.service.executePublicMint(mint(r.walletId));
    expect(outcome.ok).toBe(true);
    const row = await only(repository);
    expect(row).toMatchObject({ status: 'PENDING', txHash: HASH, nonce: 7 });
    expect(row.broadcastAt).toBeInstanceOf(Date);
    // The settler finds nothing "stuck before signing" to give up on.
    expect(await repository.listStuckSending(new Date(Date.now() + 3_600_000), 10)).toEqual([]);
  });

  it('signed, hash not saved, and the send failed: the hash is still put on record for the chain to decide', async () => {
    const error = new RpcUnavailableError({ chainId: CHAIN, walletId: 'w', walletAddress: '0x' + '1'.repeat(40), ownerId: OWNER, spendCapWei: null }, 'broadcast', new Error('timeout'));
    const repository = new InMemoryMintEventRepository();
    failFirstHashWrite(repository);
    const r = await rig({ repository, engine: { kind: 'throw-after-sign', error } });
    expect((await r.service.executePublicMint(mint(r.walletId))).ok).toBe(false);
    expect(await only(repository)).toMatchObject({ status: 'PENDING', txHash: HASH, nonce: 7 });
  });

  it("another owner's wallet: refused and nothing is recorded", async () => {
    const r = await rig();
    await expect(r.service.executePublicMint({ ...mint(r.walletId), ownerId: 'someone-else' as UserId })).rejects.toThrow();
    expect((r.repository as InMemoryMintEventRepository).rows.size).toBe(0);
  });

  it('a scheduled mint records as SCHEDULED with its job id, whatever the stored request said', async () => {
    const r = await rig();
    await dispatchScheduledMint(r.service, { kind: 'public', request: mint(r.walletId, { source: 'MANUAL' }) } as never, 'job-42');
    expect(await only(r.repository)).toMatchObject({ source: 'SCHEDULED', jobId: 'job-42' });
  });

  it('an unset source records as API', async () => {
    const r = await rig();
    await r.service.executePublicMint(mint(r.walletId));
    expect((await only(r.repository)).source).toBe('API');
  });

  it('safeNote drops URLs and newlines and caps the length', () => {
    expect(safeNote('bad\nthing at https://a.example/x?key=1')).toBe('bad thing at [url]');
    expect(safeNote('y'.repeat(500))!.length).toBe(200);
    expect(safeNote('  ')).toBeNull();
  });
});

describe('the in-memory log follows the same status rules as the Postgres trigger', () => {
  it('refuses an illegal change', async () => {
    const repo = new InMemoryMintEventRepository();
    const id = await repo.insert({ ownerId: OWNER, walletId: 'w', walletAddress: '0x', chainId: 1, contractAddress: NFT, kind: 'PUBLIC', quantity: 1, source: 'API', jobId: null, valueWei: null, status: 'SENDING' });
    await repo.update(id, { status: 'BLOCKED' });
    await expect(repo.update(id, { status: 'PENDING' })).rejects.toThrow(/illegal status change BLOCKED -> PENDING/);
  });
});

describe('the settler', () => {
  function reader(map: Record<string, 'success' | 'reverted' | 'missing' | 'rpc-down'>): ReceiptReader {
    return {
      getTransactionReceipt: async ({ hash }) => {
        const what = map[hash];
        if (what === 'missing' || what === undefined) throw Object.assign(new Error(`Transaction receipt with hash "${hash}" could not be found.`), { name: 'TransactionReceiptNotFoundError' });
        if (what === 'rpc-down') throw new Error('fetch failed');
        return { status: what, blockNumber: 123n, gasUsed: 21_000n, effectiveGasPrice: 2_000_000_000n, l1Fee: 5n };
      },
    };
  }

  async function pending(repo: InMemoryMintEventRepository, hash: string, ageMs: number, now: number) {
    const id = await repo.insert({ ownerId: OWNER, walletId: 'w', walletAddress: '0x', chainId: CHAIN, contractAddress: NFT, kind: 'PUBLIC', quantity: 1, source: 'API', jobId: null, valueWei: null, status: 'PENDING', txHash: hash, broadcastAt: new Date(now - ageMs), createdAt: new Date(now - ageMs) });
    return id;
  }

  it('confirms, reverts, waits, drops after 6 hours, and leaves rows alone when the RPC is down', async () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const repo = new InMemoryMintEventRepository();
    const ok = await pending(repo, '0xok', 60_000, now);
    const bad = await pending(repo, '0xbad', 60_000, now);
    const young = await pending(repo, '0xyoung', 60_000, now);
    const old = await pending(repo, '0xold', 7 * 3_600_000, now);
    const down = await pending(repo, '0xdown', 60_000, now);
    const settler = new MintEventSettler(repo, new Map([[CHAIN, reader({ '0xok': 'success', '0xbad': 'reverted', '0xyoung': 'missing', '0xold': 'missing', '0xdown': 'rpc-down' })]]), noopLogger, { now: () => now });
    expect(await settler.runOnce()).toBe(3);
    expect(await repo.get(ok)).toMatchObject({ status: 'CONFIRMED', blockNumber: '123', gasUsed: '21000', effectiveGasPriceWei: '2000000000', feeWei: String(21_000n * 2_000_000_000n + 5n) });
    expect((await repo.get(bad))!.status).toBe('REVERTED');
    expect((await repo.get(young))!.status).toBe('PENDING');
    expect((await repo.get(old))!.status).toBe('DROPPED');
    expect((await repo.get(down))!.status).toBe('PENDING');
  });

  it('a dropped mint that lands late is confirmed on a later look', async () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const repo = new InMemoryMintEventRepository();
    const id = await pending(repo, '0xlate', 7 * 3_600_000, now);
    const map: Record<string, 'success' | 'missing'> = { '0xlate': 'missing' };
    const settler = new MintEventSettler(repo, new Map([[CHAIN, reader(map)]]), noopLogger, { now: () => now, droppedEvery: 1 });
    await settler.runOnce();
    expect((await repo.get(id))!.status).toBe('DROPPED');
    map['0xlate'] = 'success';
    await settler.runOnce();
    expect((await repo.get(id))!.status).toBe('CONFIRMED');
  });

  it('mints that are never going to land do not keep newer ones from being settled', async () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const repo = new InMemoryMintEventRepository();
    // Twelve stuck sends from an hour ago, then one that has landed. A page is five rows.
    for (let i = 0; i < 12; i++) await pending(repo, `0xstuck${i}`, 3_600_000 - i, now);
    const fresh = await pending(repo, '0xfresh', 30_000, now);
    const settler = new MintEventSettler(repo, new Map([[CHAIN, reader({ '0xfresh': 'success' })]]), noopLogger, { now: () => now, batchSize: 5 });

    expect(await settler.runOnce()).toBe(0); // rows 1 to 5
    expect(await settler.runOnce()).toBe(0); // rows 6 to 10
    expect((await repo.get(fresh))!.status).toBe('PENDING');
    expect(await settler.runOnce()).toBe(1); // rows 11, 12 and the fresh one
    expect((await repo.get(fresh))!.status).toBe('CONFIRMED');

    // Then round again from the oldest: a stuck one that lands late is still picked up.
    const late = await pending(repo, '0xlate', 3_700_000, now);
    const settler2 = new MintEventSettler(repo, new Map([[CHAIN, reader({ '0xlate': 'success' })]]), noopLogger, { now: () => now, batchSize: 5 });
    expect(await settler2.runOnce()).toBe(1);
    expect((await repo.get(late))!.status).toBe('CONFIRMED');
  });

  it('rows recorded in the same millisecond are neither skipped nor read twice across pages', async () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const repo = new InMemoryMintEventRepository();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await pending(repo, `0xsame${i}`, 60_000, now));
    const seen: string[] = [];
    const counting: ReceiptReader = {
      getTransactionReceipt: async ({ hash }) => {
        seen.push(hash);
        throw Object.assign(new Error('could not be found'), { name: 'TransactionReceiptNotFoundError' });
      },
    };
    const settler = new MintEventSettler(repo, new Map([[CHAIN, counting]]), noopLogger, { now: () => now, batchSize: 3 });
    await settler.runOnce();
    await settler.runOnce();
    await settler.runOnce();
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('a row stuck before signing (process died) becomes BLOCKED "interrupted"', async () => {
    const now = Date.now();
    const repo = new InMemoryMintEventRepository();
    const id = await repo.insert({ ownerId: OWNER, walletId: 'w', walletAddress: '0x', chainId: CHAIN, contractAddress: NFT, kind: 'PUBLIC', quantity: 1, source: 'API', jobId: null, valueWei: null, status: 'SENDING', createdAt: new Date(now - 20 * 60_000) });
    await new MintEventSettler(repo, new Map(), noopLogger, { now: () => now }).runOnce();
    expect(await repo.get(id)).toMatchObject({ status: 'BLOCKED', failureReason: 'interrupted' });
  });
});

describe('signed runs are copied into the log', () => {
  it('one row per wallet, dry runs left out, safe to copy twice', async () => {
    const signed = new InMemorySignedMintRepository();
    const mintLog = new InMemoryMintEventRepository();
    const t0 = new Date('2026-09-29T10:00:00Z');
    await signed.upsertRun({ jobId: 'j1', ownerId: OWNER, chainId: CHAIN, contract: NFT, slug: 's', stageUuid: 'u', stageLabel: 'GTD', t0, dryRun: false, simulate: true, rehearsal: false, status: 'finished' });
    const base = { jobId: 'j1', ownerId: OWNER, quantity: 1 };
    await signed.upsertAttempt({ ...base, walletId: 'a', walletAddress: '0xa' }, { status: 'confirmed', txHash: '0xha', nonce: 1, blockNumber: '9', gasUsed: '100', effectiveGasPriceWei: '3', valueWei: '0', broadcastMs: 400, confirmedMs: 2000 });
    await signed.upsertAttempt({ ...base, walletId: 'b', walletAddress: '0xb' }, { status: 'broadcast', txHash: '0xhb', nonce: 2, broadcastMs: 500 });
    await signed.upsertAttempt({ ...base, walletId: 'c', walletAddress: '0xc' }, { status: 'skipped', reason: 'not_eligible', detail: 'OpenSea says no.' });
    await signed.upsertAttempt({ ...base, walletId: 'd', walletAddress: '0xd' }, { status: 'dry_run_ok' });

    expect(await copySignedRunToMintLog({ signed, mintLog, logger: noopLogger }, 'j1')).toBe(3);
    expect(await copySignedRunToMintLog({ signed, mintLog, logger: noopLogger }, 'j1')).toBe(0);
    const rows = await mintLog.listForOwner(OWNER, { limit: 10 });
    const by = (w: string) => rows.find((r) => r.walletId === w)!;
    expect(by('a')).toMatchObject({ status: 'CONFIRMED', kind: 'SIGNED', source: 'SCHEDULED', jobId: 'j1', txHash: '0xha', feeWei: '300', createdAt: t0 });
    expect(by('b')).toMatchObject({ status: 'PENDING', txHash: '0xhb' });
    expect(by('c')).toMatchObject({ status: 'BLOCKED', failureReason: 'not_eligible', failureNote: 'OpenSea says no.' });
    expect(rows.find((r) => r.walletId === 'd')).toBeUndefined();
  });
});

describe('GET /me/mints', () => {
  async function world() {
    const repository = new InMemoryMintEventRepository();
    const kms = new LocalKeyManagementProvider();
    const sessions = new RedisSessionStore(new InMemoryRedisClient());
    const app = buildApp({ walletService: new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId), logger: noopLogger, authToken: 'op', sessions, mintLog: repository });
    const row = (ownerId: string, at: Date, tx: string) =>
      repository.insert({ ownerId, walletId: 'w', walletAddress: '0x', chainId: CHAIN, contractAddress: NFT, kind: 'PUBLIC', quantity: 1, source: 'MANUAL', jobId: null, valueWei: '1', status: 'PENDING', txHash: tx, createdAt: at });
    const headers = { authorization: `Bearer ${await sessions.create('user-a')}` };
    return { app, row, headers };
  }
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it("returns only the caller's own mints, newest first, a page at a time, with when their history began", async () => {
    const w = await world();
    for (const m of [1, 2, 3]) await w.row('user-a', minutesAgo(m), `0x${m}`);
    await w.row('user-b', minutesAgo(9), '0xb');

    const first = await w.app.inject({ method: 'GET', url: '/me/mints?limit=2', headers: w.headers });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.mints.map((m: { txHash: string }) => m.txHash)).toEqual(['0x1', '0x2']);
    expect(body.mints[0]).not.toHaveProperty('ownerId');
    expect(Date.parse(body.firstAt)).toBeCloseTo(minutesAgo(3).getTime(), -3);
    const second = await w.app.inject({ method: 'GET', url: `/me/mints?limit=2&before=${encodeURIComponent(body.nextBefore)}`, headers: w.headers });
    expect(second.json()).toEqual({ mints: [expect.objectContaining({ txHash: '0x3' })], nextBefore: null });
  });

  it('never skips or repeats rows recorded in the same millisecond across a page boundary', async () => {
    const w = await world();
    const same = minutesAgo(1);
    for (let i = 0; i < 5; i++) await w.row('user-a', same, `0xs${i}`);
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const url: string = `/me/mints?limit=2${before ? `&before=${encodeURIComponent(before)}` : ''}`;
      const page = (await w.app.inject({ method: 'GET', url, headers: w.headers })).json();
      seen.push(...page.mints.map((m: { txHash: string }) => m.txHash));
      before = page.nextBefore;
    } while (before);
    expect([...seen].sort()).toEqual(['0xs0', '0xs1', '0xs2', '0xs3', '0xs4']);
  });

  it('an account with no mints gets an empty page and firstAt null; a bad cursor is a 400', async () => {
    const w = await world();
    expect((await w.app.inject({ method: 'GET', url: '/me/mints', headers: w.headers })).json()).toEqual({ mints: [], nextBefore: null, firstAt: null });
    expect((await w.app.inject({ method: 'GET', url: '/me/mints?before=yesterday', headers: w.headers })).statusCode).toBe(400);
  });
});
