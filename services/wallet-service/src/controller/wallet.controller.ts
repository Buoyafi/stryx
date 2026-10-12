import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { BulkCreateWalletInputSchema, CreateWalletInputSchema, ImportWalletInputSchema, WalletIdParamSchema, ListWalletsQuerySchema, RenameWalletInputSchema } from '../dto/wallet.dto.js';
import type { WalletService } from '../service/wallet.service.js';
import {
  WalletAddressCollisionError,
  WalletNotFoundError,
  WalletDeletionRefusedError,
  type WalletDeletionChecker,
  InvalidPrivateKeyError, BulkCreateInterruptedError } from '../service/wallet.service.js';
import type { UserId } from '../types/user-id.js';

/** ADR-002 §3.10: what a wallet-affecting route reports after it runs, success or failure. */
export interface AuditableEvent {
  action: string;
  walletId?: string;
  outcome: 'success' | 'failure';
  detail?: string;
}

export interface WalletControllerDeps {
  walletService: WalletService;
  /** Decides whether a wallet may be deleted. */
  checkDeletion?: WalletDeletionChecker;
  /** Resolves the caller's owner id for every wallet operation (ADR-002 §3.3). */
  resolveOwnerId: (request: FastifyRequest) => UserId;
  /** ADR-002 §3.10: records an audit entry for a wallet-affecting action. */
  recordAudit?: (request: FastifyRequest, event: AuditableEvent) => Promise<void>;
  /** Runs once a wallet has been deleted for good, to clear what else is kept under its id. */
  onWalletDeleted?: (walletId: string) => Promise<void>;
}

/** Fastify plugin exposing wallet endpoints. */
export const walletController: (deps: WalletControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerWalletRoutes(app: FastifyInstance) {
    const audit = (request: FastifyRequest, event: AuditableEvent): Promise<void> =>
      deps.recordAudit?.(request, event) ?? Promise.resolve();

    app.post('/wallets', async (request, reply) => {
      const input = CreateWalletInputSchema.parse(request.body);
      const wallet = await deps.walletService.createWallet(input, deps.resolveOwnerId(request));
      await audit(request, { action: 'wallet.create', walletId: wallet.id, outcome: 'success' });
      return reply.code(201).send(wallet);
    });

    app.post('/wallets/bulk', async (request, reply) => {
      const input = BulkCreateWalletInputSchema.parse(request.body);
      try {
        const wallets = await deps.walletService.createWallets(input, deps.resolveOwnerId(request));
        for (const wallet of wallets) {
          await audit(request, { action: 'wallet.create', walletId: wallet.id, outcome: 'success' });
        }
        return reply.code(201).send(wallets);
      } catch (err) {
        if (!(err instanceof BulkCreateInterruptedError)) throw err;
        // Some were made before it stopped.
        for (const wallet of err.created) {
          await audit(request, { action: 'wallet.create', walletId: wallet.id, outcome: 'success' });
        }
        await audit(request, { action: 'wallet.create', outcome: 'failure', detail: `bulk generate stopped after ${err.created.length} of ${err.requested}` });
        return reply.code(207).send({ partial: true, requested: err.requested, wallets: err.created, message: `${err.message} The ${err.created.length} below are ready to use.` });
      }
    });

    // List all of the caller's wallets (summaries only, never key material).
    app.get('/wallets', async (request, reply) => {
      const q = ListWalletsQuerySchema.parse(request.query);
      const filter: { tier?: 'TREASURY' | 'HOT' | 'MINT'; status?: 'ACTIVE' | 'ARCHIVED' | 'COMPROMISED' } = {};
      if (q.tier) filter.tier = q.tier;
      if (q.status) filter.status = q.status;
      const wallets = await deps.walletService.listWallets(deps.resolveOwnerId(request), filter);
      return reply.send(wallets);
    });

    app.post('/wallets/import', async (request, reply) => {
      const input = ImportWalletInputSchema.parse(request.body);
      try {
        const wallet = await deps.walletService.importWallet(input, deps.resolveOwnerId(request));
        await audit(request, { action: 'wallet.import', walletId: wallet.id, outcome: 'success' });
        return reply.code(201).send(wallet);
      } catch (err) {
        if (err instanceof WalletAddressCollisionError) {
          await audit(request, { action: 'wallet.import', outcome: 'failure', detail: err.message });
          return reply.code(409).send({ error: err.message });
        }
        if (err instanceof InvalidPrivateKeyError) {
          await audit(request, { action: 'wallet.import', outcome: 'failure', detail: err.message });
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    });

    app.get('/wallets/:id', async (request, reply) => {
      const { id } = WalletIdParamSchema.parse(request.params);
      try {
        const wallet = await deps.walletService.getWalletSummary(deps.resolveOwnerId(request), id);
        return reply.send(wallet);
      } catch (err) {
        if (err instanceof WalletNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    });

    app.patch('/wallets/:id', async (request, reply) => {
      const { id } = WalletIdParamSchema.parse(request.params);
      const { label } = RenameWalletInputSchema.parse(request.body);
      try {
        const wallet = await deps.walletService.renameWallet(deps.resolveOwnerId(request), id, label);
        await audit(request, { action: 'wallet.rename', walletId: id, outcome: 'success' });
        return reply.send(wallet);
      } catch (err) {
        if (err instanceof WalletNotFoundError) {
          await audit(request, { action: 'wallet.rename', walletId: id, outcome: 'failure', detail: err.message });
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    });

    app.post('/wallets/:id/archive', async (request, reply) => {
      const { id } = WalletIdParamSchema.parse(request.params);
      try {
        const wallet = await deps.walletService.archiveWallet(deps.resolveOwnerId(request), id);
        await audit(request, { action: 'wallet.archive', walletId: id, outcome: 'success' });
        return reply.send(wallet);
      } catch (err) {
        if (err instanceof WalletNotFoundError) {
          await audit(request, { action: 'wallet.archive', walletId: id, outcome: 'failure', detail: err.message });
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    });

    app.post('/wallets/:id/unarchive', async (request, reply) => {
      const { id } = WalletIdParamSchema.parse(request.params);
      try {
        const wallet = await deps.walletService.unarchiveWallet(deps.resolveOwnerId(request), id);
        await audit(request, { action: 'wallet.unarchive', walletId: id, outcome: 'success' });
        return reply.send(wallet);
      } catch (err) {
        if (err instanceof WalletNotFoundError) {
          await audit(request, { action: 'wallet.unarchive', walletId: id, outcome: 'failure', detail: err.message });
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    });

    const deleteUnavailable = {
      error: 'delete_unavailable',
      message: 'Deleting wallets needs the chains to be configured, so balances can be checked first.',
    };

    // What deleting would mean now: the delete dialog asks this before offering the button.
    app.get('/wallets/:id/deletion', async (request, reply) => {
      const { id } = WalletIdParamSchema.parse(request.params);
      if (!deps.checkDeletion) return reply.code(501).send(deleteUnavailable);
      try {
        return reply.send(await deps.walletService.deletionCheck(deps.resolveOwnerId(request), id, deps.checkDeletion));
      } catch (err) {
        if (err instanceof WalletNotFoundError) return reply.code(404).send({ error: err.message });
        throw err;
      }
    });

    // Permanent delete: Stryx forgets the wallet and its key.
    app.delete('/wallets/:id', async (request, reply) => {
      const { id } = WalletIdParamSchema.parse(request.params);
      const keySaved = (request.query as { keySaved?: string } | undefined)?.keySaved === 'true';
      if (!deps.checkDeletion) return reply.code(501).send(deleteUnavailable);

      try {
        await deps.walletService.deleteWalletPermanently(deps.resolveOwnerId(request), id, deps.checkDeletion, { keySaved });
        await deps.onWalletDeleted?.(id).catch(() => undefined);
        await audit(request, { action: 'wallet.delete', walletId: id, outcome: 'success', ...(keySaved ? { detail: 'owner confirmed the key is saved elsewhere' } : {}) });
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof WalletNotFoundError) return reply.code(404).send({ error: err.message });
        if (err instanceof WalletDeletionRefusedError) {
          await audit(request, { action: 'wallet.delete', walletId: id, outcome: 'failure', detail: err.message });
          return reply.code(409).send({ error: `cannot_delete_${err.check.reason}`, message: err.message, check: err.check });
        }
        throw err;
      }
    });

    app.post('/wallets/:id/rotate-key', async (request, reply) => {
      const { id } = WalletIdParamSchema.parse(request.params);
      try {
        const wallet = await deps.walletService.rotateWalletKey(deps.resolveOwnerId(request), id);
        await audit(request, { action: 'wallet.rotate_key', walletId: id, outcome: 'success' });
        return reply.send(wallet);
      } catch (err) {
        if (err instanceof WalletNotFoundError) {
          await audit(request, { action: 'wallet.rotate_key', walletId: id, outcome: 'failure', detail: err.message });
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    });
  };
