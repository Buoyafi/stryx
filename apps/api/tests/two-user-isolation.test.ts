import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { UserAccountService } from '@stryx/user-service';
import { noopLogger } from '@stryx/logger';
import { InMemoryMintEventRepository } from '../src/mint-event-log.js';
import { buildApp } from '../src/app.js';
import { RedisSessionStore } from '../src/session-store.js';
import { StepUpStore } from '../src/step-up-store.js';
import { SiweService } from '../src/siwe-service.js';
import { AccessCodeService } from '../src/access-code-service.js';
import { SessionCookie } from '../src/session-cookie.js';
import { RedisRateLimiter } from '../src/rate-limiter.js';
import { DisperseService } from '../src/disperse.service.js';
import { BalanceService } from '../src/balance.service.js';
import { NftLedgerService } from '../src/nft-ledger.service.js';
import { NftTransferService } from '../src/nft-transfer.service.js';
import { NftHoldingsService } from '../src/nft-holdings.service.js';
import { MintExecutionService } from '../src/mint-execution.service.js';
import { MintBatchService } from '../src/mint-batch.service.js';
import { MintPreviewService } from '../src/mint-preview.service.js';
import { MintEligibilityService } from '../src/mint-eligibility.service.js';
import { WalletKeyExportService } from '../src/wallet-key-export.service.js';
import { WalletKeyRecordProviderAdapter } from '../src/wallet-key-record-provider.js';
import { VaultSettingsService } from '../src/vault-settings.service.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import { InMemorySignedMintRepository } from '../src/signed-mint-repository.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryIdentityRepository } from './fakes/in-memory-identity-repository.js';
import { InMemoryNftLedgerRepository } from './fakes/in-memory-nft-ledger-repository.js';
import { InMemoryVaultSettingsRepository } from './fakes/in-memory-vault-settings-repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';

/** Two ordinary accounts, A and B (ADR-003 §7 step 3: "two-user contract test"). */

const CHAIN = 1;
const CONTRACT = '0x' + '1'.repeat(40);
const RECIPIENT = '0x' + '2'.repeat(40);

/** Records the path of every call made on it, and returns itself so any call chain works. */
function recorder(name: string, log: string[]) {
  const make = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_t, p) => (p === 'then' ? undefined : make(`${path}.${String(p)}`)),
      apply: () => {
        log.push(path);
        return make(`${path}()`);
      },
    });
  return make(name);
}

interface World {
  app: FastifyInstance;
  errors: string[];
  a: Record<string, string>;
  b: Record<string, string>;
  chainCalls: string[];
  walletId: string;
  scheduled: { jobId: string; ownerId: string }[];
}

async function world(): Promise<World> {
  const chainCalls: string[] = [];
  const kms = new LocalKeyManagementProvider();
  const walletKeys = new WalletKeyService(kms);
  const walletRepository = new InMemoryWalletRepository();
  const walletService = new WalletService(walletRepository, walletKeys, kms.keyId);
  const users = new InMemoryUserRepository();
  const now = new Date();
  for (const id of ['user-a', 'user-b']) {
    users.seed({ id, email: null, passwordHash: null, role: 'USER', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: true, createdAt: now, updatedAt: now });
  }
  const redis = new InMemoryRedisClient();
  const sessions = new RedisSessionStore(redis);
  const userAccountService = new UserAccountService(users);
  const chainServices = new Map([[CHAIN, recorder('chain', chainCalls)]]) as never;
  const spendCaps = makePermissiveSpendCapResolver();
  const ledger = new NftLedgerService(new InMemoryNftLedgerRepository());
  const mintExecution = new MintExecutionService(walletService, chainServices, new InMemoryAllowListStore(), recorder('opensea', chainCalls) as never, spendCaps, recorder('watcher', chainCalls) as never);
  const signedRuns = new InMemorySignedMintRepository();
  const scheduled: { jobId: string; ownerId: string }[] = [];
  // Mirrors SignedMintScheduler's contract: a non-admin sees and cancels only their own jobs.
  const scheduler = {
    schedule: async (data: { ownerId: string }) => {
      scheduled.push({ jobId: `job-${scheduled.length + 1}`, ownerId: data.ownerId });
      return `job-${scheduled.length}`;
    },
    list: async (scope: { ownerId?: string; all?: true }) => scheduled.filter((j) => scope.all || j.ownerId === scope.ownerId),
    cancel: async (jobId: string, ownerId: string, isAdmin: boolean) => {
      const job = scheduled.find((j) => j.jobId === jobId);
      if (!job || (!isAdmin && job.ownerId !== ownerId)) return 'not_found';
      scheduled.splice(scheduled.indexOf(job), 1);
      return 'cancelled';
    },
  };
  const identity = new InMemoryIdentityRepository(users);
  const mintLog = new InMemoryMintEventRepository();
  // Anything that reaches the catch-all error handler is a crash, not a refusal.
  const errors: string[] = [];

  const app = buildApp({
    walletService,
    logger: { ...noopLogger, error: (msg: string, meta?: unknown) => errors.push(`${msg} ${JSON.stringify(meta)}`) } as never,
    authToken: 'operator-token',
    userAccountService,
    sessions,
    userRepository: users,
    stepUpStore: new StepUpStore(redis),
    balanceService: new BalanceService(chainServices),
    disperseService: new DisperseService(walletService, chainServices, spendCaps),
    chainServices,
    nftTransferService: new NftTransferService(walletService, chainServices, ledger),
    nftHoldingsService: new NftHoldingsService(walletService, ledger, new Map()),
    nftLedgerService: ledger,
    mintExecutionService: mintExecution,
    mintBatchService: new MintBatchService(walletService, chainServices, mintExecution),
    mintPreviewService: new MintPreviewService(walletService, chainServices, mintExecution),
    mintEligibilityService: new MintEligibilityService(walletService, chainServices, mintExecution, recorder('openSeaEligibility', chainCalls) as never),
    walletKeyExportService: new WalletKeyExportService(walletService, walletKeys, new WalletKeyRecordProviderAdapter(walletRepository)),
    vaultSettingsService: new VaultSettingsService(new InMemoryVaultSettingsRepository()),
    emergencyStopGuard: recorder('emergencyStop', chainCalls) as never,
    mintLog,
    platformStats: recorder('platformStats', chainCalls) as never,
    signedMint: {
      scheduler: scheduler as never,
      repository: signedRuns,
      walletService,
      resolveStage: async () => {
        throw new Error('not reached in this test');
      },
      executionEnabled: true,
      retryIntervalMs: 250,
      giveUpMs: 60_000,
    },
    walletSignIn: {
      appOrigin: 'https://app.stryx.test',
      siwe: new SiweService(redis, 'https://app.stryx.test'),
      codes: new AccessCodeService(identity, redis, 'x'.repeat(40)),
      identity,
      sessionCookie: new SessionCookie('https://app.stryx.test'),
      limiter: new RedisRateLimiter(redis),
    },
  });

  const a = { authorization: `Bearer ${await sessions.create('user-a')}` };
  const b = { authorization: `Bearer ${await sessions.create('user-b')}` };

  // A's things: a wallet, a vault setting, a finished signed-mint run and a scheduled one.
  const created = await app.inject({ method: 'POST', url: '/wallets', headers: a, payload: { label: 'A main' } });
  expect(created.statusCode).toBe(201);
  const walletId = created.json().id as string;
  await app.inject({ method: 'POST', url: '/auth/step-up', headers: a, payload: { credential: 'unused' } }); // A has no password: refused, no grant
  await new StepUpStore(redis).grant('user-a' as never);
  const vault = await app.inject({ method: 'PUT', url: '/vault-settings', headers: a, payload: { chainId: CHAIN, enabled: true, vaultAddress: RECIPIENT } });
  expect(vault.statusCode).toBe(200);
  await signedRuns.upsertRun({ jobId: 'run-a', ownerId: 'user-a', chainId: CHAIN, contract: CONTRACT, slug: 's', stageUuid: 'u', stageLabel: 'FCFS', t0: now, dryRun: false, simulate: true, rehearsal: false, status: 'done' });
  scheduled.push({ jobId: 'job-a', ownerId: 'user-a' });
  await mintLog.insert({ ownerId: 'user-a', walletId, walletAddress: '0x', chainId: CHAIN, contractAddress: CONTRACT, kind: 'PUBLIC', quantity: 1, source: 'MANUAL', jobId: null, valueWei: '0', status: 'PENDING', txHash: '0xaaa' });

  // B may do sensitive things to their own account, so a missing step-up is never why B is refused.
  await new StepUpStore(redis).grant('user-b' as never);
  chainCalls.length = 0;
  errors.length = 0;
  return { app, errors, a, b, chainCalls, walletId, scheduled };
}

const refused = (status: number) => status === 403 || status === 404;

describe("one account cannot reach another's data", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("B does not see A's wallet in any list", async () => {
    const list = await w.app.inject({ method: 'GET', url: '/wallets', headers: w.b });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(w.walletId);
    const archived = await w.app.inject({ method: 'GET', url: '/wallets?status=ARCHIVED', headers: w.b });
    expect(JSON.stringify(archived.json())).not.toContain(w.walletId);
    // A (the positive control) does see it.
    expect(JSON.stringify((await w.app.inject({ method: 'GET', url: '/wallets', headers: w.a })).json())).toContain(w.walletId);
  });

  it("every route aimed at A's wallet is refused for B, and A's wallet is unchanged", async () => {
    const id = w.walletId;
    const attempts: [string, string, unknown?][] = [
      ['GET', `/wallets/${id}`],
      ['PATCH', `/wallets/${id}`, { label: 'taken' }],
      ['POST', `/wallets/${id}/archive`],
      ['POST', `/wallets/${id}/unarchive`],
      ['POST', `/wallets/${id}/rotate-key`],
      ['GET', `/wallets/${id}/balances`],
      ['GET', `/wallets/${id}/nfts?chainId=${CHAIN}`],
      ['POST', `/wallets/${id}/export-key`],
      ['GET', `/wallets/${id}/deletion`],
      ['DELETE', `/wallets/${id}`],
      ['DELETE', `/wallets/${id}?keySaved=true`],
      ['POST', '/wallets/disperse', { sourceWalletId: id, chainId: CHAIN, recipients: [{ address: RECIPIENT, amount: '0.01' }] }],
      ['POST', '/wallets/nfts/transfer', { chainId: CHAIN, destination: RECIPIENT, items: [{ walletId: id, contract: CONTRACT, tokenId: '1', standard: 'erc721' }] }],
      ['POST', '/mints/seadrop/public', { walletId: id, nftContract: CONTRACT, chainId: CHAIN, quantity: 1 }],
      ['POST', '/mints/seadrop/batch', { stage: 'public', walletIds: [id], nftContract: CONTRACT, chainId: CHAIN, quantity: 1 }],
      ['POST', '/mints/seadrop/preview', { stage: 'public', walletIds: [id], nftContract: CONTRACT, chainId: CHAIN }],
      ['POST', `/chains/${CHAIN}/wallets/warm-nonces`, { walletIds: [id] }],
      ['POST', `/chains/${CHAIN}/collections/${CONTRACT}/eligibility`, { slug: null, walletIds: [id], phase: { id: 'public', name: 'Public', kind: 'public', priceWei: '0', startMs: null, endMs: null, maxPerWallet: null, source: 'on-chain', mechanism: null, openSeaStageUuid: null } }],
    ];
    const leaks: string[] = [];
    for (const [method, url, payload] of attempts) {
      const res = await w.app.inject({ method: method as 'GET', url, headers: w.b, ...(payload !== undefined ? { payload: payload as object } : {}) });
      const body = res.body;
      // Refused outright, or (for batch/preview rows) answered only with a per-wallet "not found".
      const ok = refused(res.statusCode) || (res.statusCode === 200 && /not.?found/i.test(body) && !/privateKey|0x[0-9a-f]{64}"/i.test(body));
      if (!ok) leaks.push(`${method} ${url} -> ${res.statusCode} ${body.slice(0, 160)}`);
      if (/privateKey/i.test(body)) leaks.push(`${method} ${url} returned a private key`);
    }
    expect(leaks).toEqual([]);
    // Nothing was signed, sent, simulated or read for A's wallet.
    expect(w.chainCalls.filter((c) => c !== 'chain.seaDropSupport.isDeployed')).toEqual([]);
    expect(w.errors).toEqual([]); // refused cleanly, never by crashing

    const still = await w.app.inject({ method: 'GET', url: `/wallets/${id}`, headers: w.a });
    expect(still.statusCode).toBe(200);
    expect(still.json()).toMatchObject({ id, label: 'A main', status: 'ACTIVE' });
  });

  it("B's vault setting is B's own; A's is untouched", async () => {
    const mine = await w.app.inject({ method: 'GET', url: `/vault-settings?chainId=${CHAIN}`, headers: w.b });
    expect(mine.json()).toMatchObject({ enabled: false, vaultAddress: null });
    await w.app.inject({ method: 'PUT', url: '/vault-settings', headers: w.b, payload: { chainId: CHAIN, enabled: false, vaultAddress: null } });
    const theirs = await w.app.inject({ method: 'GET', url: `/vault-settings?chainId=${CHAIN}`, headers: w.a });
    expect(theirs.json()).toMatchObject({ enabled: true, vaultAddress: RECIPIENT });
  });

  it("B cannot list, read the report of, or cancel A's signed mints", async () => {
    const list = await w.app.inject({ method: 'GET', url: '/signed-mints', headers: w.b });
    expect(list.json().jobs).toEqual([]);
    const report = await w.app.inject({ method: 'GET', url: '/signed-mints/run-a/report', headers: w.b });
    expect(report.statusCode).toBe(404);
    const cancel = await w.app.inject({ method: 'DELETE', url: '/signed-mints/job-a', headers: w.b });
    expect(cancel.statusCode).toBe(404);
    expect(w.scheduled).toEqual([{ jobId: 'job-a', ownerId: 'user-a' }]);
    // A (the positive control) can read their own report.
    expect((await w.app.inject({ method: 'GET', url: '/signed-mints/run-a/report', headers: w.a })).statusCode).toBe(200);
  });

  it('a member cannot reach any admin route', async () => {
    const admin: [string, string, unknown?][] = [
      ['GET', '/admin/access-codes'],
      ['GET', '/admin/overview'],
      ['GET', '/admin/activity'],
      ['GET', '/admin/members'],
      ['GET', '/admin/audit'],
      ['GET', '/admin/members/user-a'],
      ['POST', '/admin/members/user-a/suspend', {}],
      ['POST', '/admin/members/user-a/unsuspend'],
      ['POST', '/admin/access-codes', {}],
      ['POST', '/admin/access-codes/some-id/revoke'],
      ['POST', '/admin/emergency-stop/global', { reason: 'x' }],
      ['DELETE', '/admin/emergency-stop/global'],
      ['POST', `/admin/emergency-stop/wallets/${w.walletId}`, { reason: 'x' }],
      ['DELETE', `/admin/emergency-stop/wallets/${w.walletId}`],
      ['POST', '/admin/emergency-stop/users/user-a', { reason: 'x' }],
      ['DELETE', '/admin/emergency-stop/users/user-a'],
    ];
    const let_through: string[] = [];
    for (const [method, url, payload] of admin) {
      const res = await w.app.inject({ method: method as 'GET', url, headers: w.b, ...(payload !== undefined ? { payload: payload as object } : {}) });
      if (res.statusCode !== 403) let_through.push(`${method} ${url} -> ${res.statusCode}`);
    }
    expect(let_through).toEqual([]);
    expect(w.chainCalls).toEqual([]); // no stop was set or cleared
  });

  it("B's mint history holds none of A's mints", async () => {
    expect((await w.app.inject({ method: 'GET', url: '/me/mints', headers: w.b })).json()).toEqual({ mints: [], nextBefore: null, firstAt: null });
    // A (the positive control) sees their own.
    expect((await w.app.inject({ method: 'GET', url: '/me/mints', headers: w.a })).json().mints).toHaveLength(1);
  });

  it("B's profile change is B's alone", async () => {
    await w.app.inject({ method: 'PATCH', url: '/me/profile', headers: w.b, payload: { xHandle: 'bee', displayName: 'Bee' } });
    expect((await w.app.inject({ method: 'GET', url: '/auth/me', headers: w.a })).json()).toMatchObject({ id: 'user-a', xHandle: null, displayName: null });
  });
});
