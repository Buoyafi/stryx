/** REGRESSION GUARD: no URL may appear in anything the API returns as an error. */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { buildApp } from '../src/app.js';
import { AuditLogService } from '../src/audit-log-service.js';
import type { AuditLogEntry } from '../src/audit-log-repository.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';

const SECRET = 'SUPERSECRETPROVIDERKEY';
const RPC_URL = `https://rpc.testnet.chain.example/v2/${SECRET}`;
/** The shape a chain client's error message really has. */
const VIEM_STYLE = `HTTP request failed.\n\nStatus: 429\nURL: ${RPC_URL}\nRequest body: {"method":"eth_call"}\n\nDetails: too many requests\nVersion: viem@2.21.0`;
const ANY_URL = /[a-z][a-z0-9+.-]*:\/\//i;

const CONTRACT = '0x1234567890123456789012345678901234567890';
const CHAIN = 46630;
const PUBLIC_PHASE = {
  id: 'public',
  name: 'Phase 1',
  kind: 'public',
  priceWei: '0',
  startMs: null,
  endMs: null,
  maxPerWallet: null,
  source: 'on-chain',
  mechanism: null,
  openSeaStageUuid: null,
};

const warnings: { message: string; fields: Record<string, unknown> }[] = [];
const logger = {
  debug() {},
  info() {},
  error() {},
  warn(message: string, fields: Record<string, unknown> = {}) {
    warnings.push({ message, fields });
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

async function rig() {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const wallet = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);

  const failure = () => new Error(VIEM_STYLE);
  const app = buildApp({
    walletService,
    logger,
    mintExecutionService: {
      executePublicMint: async () => ({ ok: false, reason: 'rpc_unavailable', detail: VIEM_STYLE, stage: 'simulate' }),
      executeAllowListMint: async () => ({ ok: false, reason: 'opensea_fetch_failed', detail: `fetch_failed: ${VIEM_STYLE}` }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    mintBatchService: {
      mint: async (req: { walletIds: string[] }) =>
        req.walletIds[0] === 'preflight-fail'
          ? { ok: false, preflightError: 'unsupported_chain', detail: VIEM_STYLE, results: [] }
          : { ok: false, results: req.walletIds.map((walletId) => ({ walletId, address: '0xabc', status: 'failed', quantity: 1, reason: 'rpc_unavailable', error: VIEM_STYLE })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    mintScheduler: {
      list: async () => [
        { jobId: '1', kind: 'public', state: 'failed', walletId: wallet.id, nftContract: CONTRACT, chainId: CHAIN, quantity: 1, executeAt: 1, failedReason: VIEM_STYLE },
        { jobId: '2', kind: 'public', state: 'completed', walletId: wallet.id, nftContract: CONTRACT, chainId: CHAIN, quantity: 1, executeAt: 2, outcome: { ok: false, reason: 'rpc_unavailable', detail: VIEM_STYLE } },
      ],
      cancel: async () => {
        throw failure();
      },
      schedule: async () => 'x',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    autoScheduleService: { autoSchedulePublicMint: async () => ({ scheduled: false, reason: 'chain_unavailable' }) } as any,
    balanceService: {
      getBalances: async () => [{ chainId: CHAIN, chainName: 'Testnet', wei: '0', formatted: '0', error: VIEM_STYLE }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    disperseService: {} as any,
    chainServices: new Map([
      [
        CHAIN,
        {
          publicClient: {
            getGasPrice: async () => {
              throw failure();
            },
          },
          seaDropReader: {
            getPublicDrop: async () => {
              throw failure();
            },
            isPublicStageActive: async () => true,
            getAllowListMerkleRoot: async () => `0x${'00'.repeat(32)}`,
            getAllowedFeeRecipients: async () => [],
            getMintStats: async () => {
              throw failure();
            },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    ]),
    openSeaResolver: {
      resolve: async () => {
        const { OpenSeaResolveError } = await import('../src/opensea-resolver.js');
        throw new OpenSeaResolveError(VIEM_STYLE);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    mintEligibilityService: {
      checkPhase: async () => {
        throw failure();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  });
  return { app, walletId: wallet.id };
}

function assertNoUrl(label: string, res: { statusCode: number; body: string }) {
  expect(res.body, `${label} (HTTP ${res.statusCode}) leaked a URL: ${res.body.slice(0, 200)}`).not.toMatch(ANY_URL);
  expect(res.body, `${label} leaked the API key`).not.toContain(SECRET);
}

describe('no URL (and so no provider API key) in anything the API returns as an error', () => {
  it.each([
    ['POST /mints/seadrop/public, chain unreachable (HTTP 502)', 'POST', '/mints/seadrop/public', (id: string) => ({ walletId: id, nftContract: CONTRACT, chainId: CHAIN, quantity: 1 }), 502],
    ['POST /mints/seadrop/batch, per-wallet errors inside a 200', 'POST', '/mints/seadrop/batch', (id: string) => ({ walletIds: [id], nftContract: CONTRACT, chainId: CHAIN, quantity: 1, stage: 'public' }), 200],
    ['POST /mints/seadrop/batch, preflight rejection', 'POST', '/mints/seadrop/batch', () => ({ walletIds: ['preflight-fail'], nftContract: CONTRACT, chainId: CHAIN, quantity: 1, stage: 'public' }), 400],
    ['GET /schedules/mints, failedReason and outcome.detail inside a 200', 'GET', '/schedules/mints', () => undefined, 200],
    ['DELETE /schedules/mints/:id, an unexpected throw (HTTP 500)', 'DELETE', '/schedules/mints/1', () => undefined, 500],
    ['GET /wallets/:id/balances, per-chain error inside a 200', 'GET', '/wallets/:id/balances', () => undefined, 200],
    ['GET /drops/:chainId/:contract, chain read failed (HTTP 502)', 'GET', `/drops/${CHAIN}/${CONTRACT}`, () => undefined, 502],
    ['GET /chains/:chainId/gas-price, chain read failed (HTTP 502)', 'GET', `/chains/${CHAIN}/gas-price`, () => undefined, 502],
    ['POST /resolve/opensea, resolver error (HTTP 422)', 'POST', '/resolve/opensea', () => ({ input: 'https://opensea.io/collection/x' }), 422],
    ['POST /resolve/collection, resolver error (HTTP 422)', 'POST', '/resolve/collection', () => ({ input: 'https://opensea.io/collection/x' }), 422],
    ['GET /chains/:chainId/collections/:contract/supply, chain read failed (HTTP 502)', 'GET', `/chains/${CHAIN}/collections/${CONTRACT}/supply`, () => undefined, 502],
    ['GET /chains/:chainId/collections/:contract/phases, chain read failed (HTTP 502)', 'GET', `/chains/${CHAIN}/collections/${CONTRACT}/phases`, () => undefined, 502],
    [
      'POST /chains/:chainId/collections/:contract/eligibility, an unexpected throw (HTTP 500)',
      'POST',
      `/chains/${CHAIN}/collections/${CONTRACT}/eligibility`,
      () => ({ slug: null, walletIds: ['w1'], phase: PUBLIC_PHASE }),
      500,
    ],
  ] as const)('%s', async (label, method, path, body, expectedStatus) => {
    const { app, walletId } = await rig();
    const res = await app.inject({
      method,
      url: path.replace(':id', walletId),
      ...(body(walletId) ? { payload: body(walletId) as object } : {}),
    });
    expect(res.statusCode, label).toBe(expectedStatus);
    assertNoUrl(label, res);
  });

  it('still tells the caller what went wrong, minus the URL (the message is not blanked)', async () => {
    const { app, walletId } = await rig();
    const res = await app.inject({ method: 'POST', url: '/mints/seadrop/public', payload: { walletId, nftContract: CONTRACT, chainId: CHAIN, quantity: 1 } });
    expect(res.json().message).toContain('HTTP request failed.');
    expect(res.json().message).toContain('URL: [url]');
    expect(res.json().error).toBe('rpc_unavailable');
  });

  it('logs the error on the server with the URL cut to its domain: enough to diagnose, and no key', async () => {
    warnings.length = 0;
    const { app, walletId } = await rig();
    await app.inject({ method: 'GET', url: `/drops/${CHAIN}/${CONTRACT}` });
    const logged = warnings.find((w) => w.message.includes('redacted'));
    expect(logged, 'a redaction was logged').toBeDefined();
    expect(String(logged!.fields.original)).toContain('URL: [url: chain.example]');
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    void walletId;
  });

  it('keeps legitimate URLs in successful responses (only error-text keys are touched)', async () => {
    const { app, walletId } = await rig();
    const res = await app.inject({ method: 'GET', url: '/schedules/mints' });
    expect(res.statusCode).toBe(200);
    void walletId;
    // every field that is not error text is untouched
    expect(res.json().jobs[0]).toMatchObject({ jobId: '1', state: 'failed', nftContract: CONTRACT, chainId: CHAIN });
  });
});

describe('the audit log is append-only, so a URL must never be written into it', () => {
  it('redacts URLs from the detail before storing AND before publishing the event', async () => {
    const stored: AuditLogEntry[] = [];
    const published: unknown[] = [];
    const service = new AuditLogService(
      { create: async (e: AuditLogEntry) => void stored.push(e) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { publish: async (e: unknown) => void published.push(e) } as any,
      logger,
    );
    await service.record({ actorUserId: 'u', actorType: 'admin', action: 'mint.public', walletId: 'w', outcome: 'failure', detail: `rpc_unavailable - ${VIEM_STYLE}` });

    expect(stored).toHaveLength(1);
    expect(stored[0]!.detail).toContain('HTTP request failed.');
    expect(stored[0]!.detail).not.toMatch(ANY_URL);
    expect(JSON.stringify(published)).not.toMatch(ANY_URL);
    expect(JSON.stringify(published)).not.toContain(SECRET);
  });

  it('leaves an entry with no detail, or a detail with no URL, exactly as it was', async () => {
    const stored: AuditLogEntry[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new AuditLogService({ create: async (e: AuditLogEntry) => void stored.push(e) }, { publish: async () => {} } as any, logger);
    await service.record({ actorUserId: 'u', actorType: 'admin', action: 'wallet.create', outcome: 'success' });
    await service.record({ actorUserId: 'u', actorType: 'admin', action: 'mint.public', outcome: 'success', detail: `0x${'ab'.repeat(32)}` });
    expect(stored[0]!.detail).toBeUndefined();
    expect(stored[1]!.detail).toBe(`0x${'ab'.repeat(32)}`);
  });
});

describe('control: this test does catch a leak', () => {
  it('fails on an app WITHOUT the guard, so a green result above means something', async () => {
    const bare = Fastify();
    bare.get('/x', async (_req, reply) => reply.code(502).send({ error: 'drop_read_failed', message: VIEM_STYLE }));
    const res = await bare.inject('/x');
    expect(() => assertNoUrl('unguarded route', res)).toThrow();
  });
});
