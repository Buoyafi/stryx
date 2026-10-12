import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WalletNotFoundError, type UserId } from '@stryx/wallet-service';
import type { AuditLogService } from './audit-log-service.js';
import type { WalletKeyExportService } from './wallet-key-export.service.js';
import type { StepUpStore } from './step-up-store.js';
import { consumeStepUp } from './step-up-controller.js';

export interface KeyExportControllerDeps {
  walletKeyExportService: WalletKeyExportService;
  stepUpStore: StepUpStore;
  resolveOwnerId: (request: FastifyRequest) => UserId;
  auditLogService?: AuditLogService;
}

/** Operator dashboard only: a session-authenticated (user dashboard) caller is refused outright. */
export const keyExportController: (deps: KeyExportControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerKeyExportRoutes(app: FastifyInstance) {
    app.post('/wallets/:id/export-key', async (request, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

      if (request.sessionToken) {
        return reply.code(403).send({ error: 'operator_only', message: 'Key export is only available on the operator dashboard.' });
      }

      const ownerId = deps.resolveOwnerId(request);
      if (!(await consumeStepUp(deps.stepUpStore, ownerId, reply))) return;

      const audit = (outcome: 'success' | 'failure', detail?: string) =>
        deps.auditLogService?.record({
          actorUserId: ownerId,
          actorType: 'admin',
          action: 'wallet.export_key',
          walletId: id,
          outcome,
          detail: detail ?? null,
        });

      try {
        const exported = await deps.walletKeyExportService.exportKey(ownerId, id);
        await audit('success');
        return reply.header('Cache-Control', 'no-store').send(exported);
      } catch (err) {
        if (err instanceof WalletNotFoundError) {
          await audit('failure', 'wallet not found');
          return reply.code(404).send({ error: 'wallet_not_found' });
        }
        await audit('failure', 'export failed');
        throw err;
      }
    });
  };
