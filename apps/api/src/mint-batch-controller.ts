import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserId } from '@stryx/wallet-service';
import { MAX_QUANTITY_PER_MINT, type MintBatchService, type BatchMintRequest } from './mint-batch.service.js';
import type { AuditLogService } from './audit-log-service.js';
import { PriorityFeeGweiField, resolvePriorityFee } from './priority-fee.js';
import { credentialActorType } from './audit-actor.js';

const BaseFields = {
  nftContract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().positive(),
  walletIds: z.array(z.string().min(1)).min(1).max(100), // MintBatchService enforces the tighter MAX_BATCH_WALLETS
  quantity: z.union([z.literal('max'), z.number().int().positive().max(MAX_QUANTITY_PER_MINT)]),
  priorityFeeGwei: PriorityFeeGweiField,
};

// A plain union with a nested discriminated union: two branches share the stage 'allowlist', which one
// discriminatedUnion cannot express.
const BatchMintInputSchema = z.union([
  z.object({ ...BaseFields, stage: z.literal('public') }),
  z.discriminatedUnion('proofSource', [
    z.object({ ...BaseFields, stage: z.literal('allowlist'), proofSource: z.literal('opensea'), slug: z.string().min(1) }),
    z.object({ ...BaseFields, stage: z.literal('allowlist'), proofSource: z.literal('stored'), allowListId: z.string().min(1) }),
  ]),
]);

export interface MintBatchControllerDeps {
  mintBatchService: MintBatchService;
  resolveOwnerId: (request: FastifyRequest) => UserId;
  /** ADR-002 §3.10. Optional so tests that don't care about audit logging don't need it wired up. */
  auditLogService?: AuditLogService;
}

/** Thin HTTP wrapper over MintBatchService: the multi-wallet mint's "fire" action. */
export const mintBatchController: (deps: MintBatchControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerMintBatchRoutes(app: FastifyInstance) {
    app.post('/mints/seadrop/batch', async (request, reply) => {
      const input = BatchMintInputSchema.parse(request.body);
      const ownerId = deps.resolveOwnerId(request);
      const fee = resolvePriorityFee(input.chainId, input.priorityFeeGwei);
      if (!fee.ok) return reply.code(400).send({ error: 'invalid_priority_fee', message: fee.message, results: [] });
      const tip = fee.priorityFeeWei ? { priorityFeeWei: fee.priorityFeeWei } : {};

      const base: BatchMintRequest =
        input.stage === 'public'
          ? { ownerId, nftContract: input.nftContract as `0x${string}`, chainId: input.chainId, walletIds: input.walletIds, quantity: input.quantity, stage: 'public' }
          : input.proofSource === 'opensea'
            ? { ownerId, nftContract: input.nftContract as `0x${string}`, chainId: input.chainId, walletIds: input.walletIds, quantity: input.quantity, stage: 'allowlist', proofSource: 'opensea', slug: input.slug }
            : { ownerId, nftContract: input.nftContract as `0x${string}`, chainId: input.chainId, walletIds: input.walletIds, quantity: input.quantity, stage: 'allowlist', proofSource: 'stored', allowListId: input.allowListId };

      const req: BatchMintRequest = { ...base, ...tip, source: request.sessionToken ? 'MANUAL' : 'API' };
      const outcome = await deps.mintBatchService.mint(req);
      const actorType = credentialActorType(request);
      const action = input.stage === 'public' ? 'mint.public' : 'mint.allowlist';

      if (outcome.preflightError) {
        await deps.auditLogService?.record({
          actorUserId: ownerId,
          actorType,
          action,
          outcome: 'failure',
          detail: `${outcome.preflightError}: ${outcome.detail ?? ''}`,
        });
        const status = outcome.preflightError === 'unsupported_chain' ? 400 : outcome.preflightError === 'too_many_wallets' ? 413 : 400;
        return reply.code(status).send({ error: outcome.preflightError, message: outcome.detail, results: [] });
      }

      await Promise.all(
        outcome.results.map((row) =>
          deps.auditLogService?.record({
            actorUserId: ownerId,
            actorType,
            action,
            walletId: row.walletId,
            outcome: row.status === 'sent' ? 'success' : 'failure',
            detail:
              row.status === 'sent'
                ? (row.hash ?? '')
                : `${row.status}${row.reason ? `:${row.reason}` : ''}${row.error ? ` - ${row.error}` : ''}`,
          }),
        ),
      );

      // Past preflight this is a real, possibly partial outcome: 200 with per-wallet detail.
      return reply.code(200).send(outcome);
    });
  };
