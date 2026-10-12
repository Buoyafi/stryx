import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserId } from '@stryx/wallet-service';
import type { MintExecutionService } from './mint-execution.service.js';
import { sendMintOutcome } from './mint-outcome-http.js';
import type { AuditLogService } from './audit-log-service.js';
import { credentialActorType } from './audit-actor.js';

const MintPublicInputSchema = z.object({
  walletId: z.string().min(1),
  nftContract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().positive(),
  quantity: z.number().int().positive().max(50),
});

export interface MintControllerDeps {
  mintExecutionService: MintExecutionService;
  /** Resolves the caller's owner id (ADR-002 §3.3/§3.6): see wallet.controller.ts's dep of the same name. */
  resolveOwnerId: (request: FastifyRequest) => UserId;
  /** ADR-002 §3.10. Optional so tests that don't care about audit logging don't need it wired up. */
  auditLogService?: AuditLogService;
}

/** Thin HTTP wrapper over MintExecutionService.executePublicMint: validates input and maps the typed outcome to a status. */
export const mintController: (deps: MintControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerMintRoutes(app: FastifyInstance) {
    app.post('/mints/seadrop/public', async (request, reply) => {
      const input = MintPublicInputSchema.parse(request.body);
      const ownerId = deps.resolveOwnerId(request);
      const outcome = await deps.mintExecutionService.executePublicMint({
        ownerId,
        walletId: input.walletId,
        nftContract: input.nftContract as `0x${string}`,
        chainId: input.chainId,
        quantity: input.quantity,
        source: request.sessionToken ? 'MANUAL' : 'API',
      });
      await deps.auditLogService?.record({
        actorUserId: ownerId,
        actorType: credentialActorType(request),
        action: 'mint.public',
        walletId: input.walletId,
        outcome: outcome.ok ? 'success' : 'failure',
        detail: outcome.ok ? outcome.result.hash : outcome.reason,
      });
      return sendMintOutcome(reply, outcome);
    });
  };
