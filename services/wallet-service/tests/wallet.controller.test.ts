import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '../src/service/wallet.service.js';
import { walletController, type AuditableEvent } from '../src/controller/wallet.controller.js';
import type { UserId } from '../src/types/user-id.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';

const TEST_OWNER_ID = 'test-owner' as UserId;

async function buildApp(auditLog?: AuditableEvent[]): Promise<FastifyInstance> {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);

  const app = Fastify();
  await app.register(
    walletController({
      walletService,
      resolveOwnerId: () => TEST_OWNER_ID,
      ...(auditLog ? { recordAudit: async (_request, event) => void auditLog.push(event) } : {}),
    }),
  );
  return app;
}

describe('wallet controller', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  it('POST /wallets creates a wallet and never returns key material', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/wallets',
      payload: { label: 'My wallet', tier: 'HOT' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(body).not.toHaveProperty('encryptedPrivateKey');
    expect(body).not.toHaveProperty('wrappedDek');
  });

  it('GET /wallets/:id returns 404 for an unknown wallet', async () => {
    const response = await app.inject({ method: 'GET', url: '/wallets/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });

  it('GET /wallets lists wallets and never exposes key material', async () => {
    await app.inject({ method: 'POST', url: '/wallets', payload: { tier: 'HOT' } });
    await app.inject({ method: 'POST', url: '/wallets', payload: { tier: 'TREASURY' } });

    const response = await app.inject({ method: 'GET', url: '/wallets' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body[0]).not.toHaveProperty('encryptedPrivateKey');
    expect(body[0]).not.toHaveProperty('wrappedDek');
  });

  it('GET /wallets?tier=HOT filters by tier', async () => {
    await app.inject({ method: 'POST', url: '/wallets', payload: { tier: 'HOT' } });
    await app.inject({ method: 'POST', url: '/wallets', payload: { tier: 'TREASURY' } });

    const response = await app.inject({ method: 'GET', url: '/wallets?tier=HOT' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBe(1);
    expect(body[0].tier).toBe('HOT');
  });

  it('GET /wallets/:id returns the created wallet', async () => {
    const created = await app.inject({ method: 'POST', url: '/wallets', payload: {} });
    const { id } = created.json();

    const response = await app.inject({ method: 'GET', url: `/wallets/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(id);
  });

  it('POST /wallets/:id/rotate-key increments keyVersion', async () => {
    const created = await app.inject({ method: 'POST', url: '/wallets', payload: {} });
    const { id } = created.json();

    const response = await app.inject({ method: 'POST', url: `/wallets/${id}/rotate-key` });
    expect(response.statusCode).toBe(200);
    expect(response.json().keyVersion).toBe(2);
  });

  it('rejects an invalid create payload with a validation error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/wallets',
      payload: { tier: 'NOT_A_REAL_TIER' },
    });
    expect(response.statusCode).toBe(500); // zod throws synchronously; Fastify's default error handler maps to 500 without a custom handler wired
  });

  it('POST /wallets/bulk creates the requested count, numbered by prefix, never returning key material', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/wallets/bulk',
      payload: { count: 3, labelPrefix: 'Drop', tier: 'HOT' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toHaveLength(3);
    expect(body.map((w: { label: string }) => w.label)).toEqual(['Drop-01', 'Drop-02', 'Drop-03']);
    for (const w of body) {
      expect(w).not.toHaveProperty('encryptedPrivateKey');
      expect(w).not.toHaveProperty('wrappedDek');
    }

    const listed = await app.inject({ method: 'GET', url: '/wallets' });
    expect(listed.json()).toHaveLength(3);
  });

  it('POST /wallets/bulk rejects a count over 100', async () => {
    const response = await app.inject({ method: 'POST', url: '/wallets/bulk', payload: { count: 101 } });
    expect(response.statusCode).toBe(500); // same synchronous zod-throw shape as the single-create validation test above
  });
});

describe('wallet controller: audit logging (ADR-002 §3.10)', () => {
  it('records a success entry for create, archive, rotate-key', async () => {
    const auditLog: AuditableEvent[] = [];
    const app = await buildApp(auditLog);

    const created = await app.inject({ method: 'POST', url: '/wallets', payload: { tier: 'HOT' } });
    const { id } = created.json();
    await app.inject({ method: 'POST', url: `/wallets/${id}/archive` });
    await app.inject({ method: 'POST', url: `/wallets/${id}/rotate-key` });

    expect(auditLog).toEqual([
      { action: 'wallet.create', walletId: id, outcome: 'success' },
      { action: 'wallet.archive', walletId: id, outcome: 'success' },
      { action: 'wallet.rotate_key', walletId: id, outcome: 'success' },
    ]);
  });

  it('records one wallet.create entry per wallet for a bulk generate, not one for the whole batch', async () => {
    const auditLog: AuditableEvent[] = [];
    const app = await buildApp(auditLog);

    await app.inject({ method: 'POST', url: '/wallets/bulk', payload: { count: 3 } });

    expect(auditLog).toHaveLength(3);
    expect(auditLog.every((e) => e.action === 'wallet.create' && e.outcome === 'success')).toBe(true);
    expect(new Set(auditLog.map((e) => e.walletId)).size).toBe(3); // three distinct wallets, not the same one logged thrice
  });

  it('records a failure entry (not a thrown/swallowed error) when the target wallet does not exist', async () => {
    const auditLog: AuditableEvent[] = [];
    const app = await buildApp(auditLog);

    const response = await app.inject({ method: 'POST', url: '/wallets/does-not-exist/archive' });

    expect(response.statusCode).toBe(404);
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]!.action).toBe('wallet.archive');
    expect(auditLog[0]!.outcome).toBe('failure');
  });

  it('works fine with no recordAudit configured at all (optional dep)', async () => {
    const app = await buildApp(); // no auditLog array: recordAudit omitted entirely
    const response = await app.inject({ method: 'POST', url: '/wallets', payload: { tier: 'HOT' } });
    expect(response.statusCode).toBe(201);
  });
});

describe('POST /wallets/import: private key format normalisation', () => {
  async function importVia(app: FastifyInstance, privateKey: string) {
    return app.inject({ method: 'POST', url: '/wallets/import', payload: { privateKey, tier: 'HOT' } });
  }

  it('a key imported WITHOUT 0x produces the same address as the same key WITH 0x', async () => {
    const withPrefix = generatePrivateKey();
    const bare = withPrefix.slice(2);
    const expected = privateKeyToAccount(withPrefix).address.toLowerCase();

    // Separate apps: within one app the second import would (correctly) 409.
    const a = await importVia(await buildApp(), withPrefix);
    const b = await importVia(await buildApp(), bare);

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().address).toBe(expected);
    expect(b.json().address).toBe(expected);
    expect(b.json().address).toBe(a.json().address);
  });

  it('trims surrounding whitespace, with or without the prefix', async () => {
    const key = generatePrivateKey();
    const expected = privateKeyToAccount(key).address.toLowerCase();

    for (const padded of [` ${key} `, `${key.slice(2)}\n`, `\t0x${key.slice(2)}\r\n`, `  ${key.slice(2)}  `]) {
      const res = await importVia(await buildApp(), padded);
      expect(res.statusCode).toBe(201);
      expect(res.json().address).toBe(expected);
    }
  });

  it('the bare and prefixed forms of one key are the SAME wallet: importing both collides (409)', async () => {
    const withPrefix = generatePrivateKey();
    const app2 = await buildApp();

    expect((await importVia(app2, withPrefix.slice(2))).statusCode).toBe(201);
    expect((await importVia(app2, withPrefix)).statusCode).toBe(409);
  });
});

describe('wallet origin over HTTP', () => {
  it('POST /wallets reports GENERATED, POST /wallets/import reports IMPORTED, and GET /wallets lists each with its own origin', async () => {
    const app = await buildApp();

    const created = await app.inject({ method: 'POST', url: '/wallets', payload: { tier: 'TREASURY' } });
    const imported = await app.inject({
      method: 'POST',
      url: '/wallets/import',
      payload: { privateKey: generatePrivateKey(), tier: 'TREASURY' },
    });

    expect(created.statusCode).toBe(201);
    expect(imported.statusCode).toBe(201);
    expect(created.json().origin).toBe('GENERATED');
    expect(imported.json().origin).toBe('IMPORTED');
    // Same tier, different origin: the two axes really are independent.
    expect(created.json().tier).toBe(imported.json().tier);

    const list = (await app.inject({ method: 'GET', url: '/wallets' })).json() as { id: string; origin: string }[];
    expect(list.find((w) => w.id === created.json().id)?.origin).toBe('GENERATED');
    expect(list.find((w) => w.id === imported.json().id)?.origin).toBe('IMPORTED');
  });
  describe('what is kept under a wallet id is cleared when the wallet is deleted', () => {
    async function build(opts: { canDelete: boolean; onWalletDeleted: (id: string) => Promise<void> }) {
      const kms = new LocalKeyManagementProvider();
      const walletService = new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId);
      const withHook = Fastify();
      await withHook.register(
        walletController({
          walletService,
          resolveOwnerId: () => TEST_OWNER_ID,
          checkDeletion: async () => ({ canDelete: opts.canDelete, reason: opts.canDelete ? 'empty' : 'has_funds', message: 'holds funds', funds: [], keyElsewhere: null, scheduled: 0 }),
          onWalletDeleted: opts.onWalletDeleted,
        }),
      );
      const created = await withHook.inject({ method: 'POST', url: '/wallets', payload: { label: 'Gone soon', tier: 'HOT' } });
      return { app: withHook, id: created.json().id as string };
    }

    it('runs once, with the id, after a delete', async () => {
      const cleared: string[] = [];
      const { app: a, id } = await build({ canDelete: true, onWalletDeleted: async (walletId) => void cleared.push(walletId) });
      expect((await a.inject({ method: 'DELETE', url: `/wallets/${id}` })).statusCode).toBe(204);
      expect(cleared).toEqual([id]);
    });

    it('does not run when the delete is refused', async () => {
      const cleared: string[] = [];
      const { app: a, id } = await build({ canDelete: false, onWalletDeleted: async (walletId) => void cleared.push(walletId) });
      expect((await a.inject({ method: 'DELETE', url: `/wallets/${id}` })).statusCode).toBe(409);
      expect(cleared).toEqual([]);
    });

    it('failing does not fail the delete, which has already happened', async () => {
      const { app: a, id } = await build({
        canDelete: true,
        onWalletDeleted: async () => {
          throw new Error('redis down');
        },
      });
      expect((await a.inject({ method: 'DELETE', url: `/wallets/${id}` })).statusCode).toBe(204);
      expect((await a.inject({ method: 'GET', url: `/wallets/${id}` })).statusCode).toBe(404);
    });
  });
});
