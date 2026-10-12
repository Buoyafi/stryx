import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MintParams } from '@stryx/nft-engine';
import type { UserId } from '@stryx/wallet-service';
import type { MintExecutionService, AllowListMintRequest } from './mint-execution.service.js';
import { sendMintOutcome } from './mint-outcome-http.js';
import type { AuditLogService } from './audit-log-service.js';
import { credentialActorType } from './audit-actor.js';

/** mintParams arrives over JSON, so its two uint256 fields come as strings. */
const MintParamsInputSchema = z.object({
  mintPrice: z.string().regex(/^\d+$/),
  maxTotalMintableByWallet: z.number().int().nonnegative(),
  startTime: z.number().int().nonnegative(),
  endTime: z.number().int().nonnegative(),
  dropStageIndex: z.number().int().nonnegative(),
  maxTokenSupplyForStage: z.string().regex(/^\d+$/),
  feeBps: z.number().int().nonnegative(),
  restrictFeeRecipients: z.boolean(),
});

function toMintParams(input: z.infer<typeof MintParamsInputSchema>): MintParams {
  return {
    mintPrice: BigInt(input.mintPrice),
    maxTotalMintableByWallet: input.maxTotalMintableByWallet,
    startTime: input.startTime,
    endTime: input.endTime,
    dropStageIndex: input.dropStageIndex,
    maxTokenSupplyForStage: BigInt(input.maxTokenSupplyForStage),
    feeBps: input.feeBps,
    restrictFeeRecipients: input.restrictFeeRecipients,
  };
}

const BaseFields = {
  walletId: z.string().min(1),
  nftContract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().positive(),
  quantity: z.number().int().positive().max(50),
};

const AllowListMintInputSchema = z.discriminatedUnion('proofSource', [
  z.object({
    ...BaseFields,
    proofSource: z.literal('direct'),
    mintParams: MintParamsInputSchema,
    proof: z.array(z.string().regex(/^0x[a-fA-F0-9]{64}$/)),
  }),
  z.object({
    ...BaseFields,
    proofSource: z.literal('stored'),
    allowListId: z.string().min(1),
  }),
  z.object({
    ...BaseFields,
    proofSource: z.literal('opensea'),
    slug: z.string().min(1),
  }),
]);

export interface AllowListMintControllerDeps {
  mintExecutionService: MintExecutionService;
  /** Resolves the caller's owner id (ADR-002 §3.3/§3.6): see wallet.controller.ts's dep of the same name. */
  resolveOwnerId: (request: FastifyRequest) => UserId;
  /** ADR-002 §3.10. Optional so tests that don't care about audit logging don't need it wired up. */
  auditLogService?: AuditLogService;
}

/** Thin HTTP wrapper over MintExecutionService.executeAllowListMint. */
export const allowListMintController: (deps: AllowListMintControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerAllowListMintRoutes(app: FastifyInstance) {
    app.post('/mints/seadrop/allowlist', async (request, reply) => {
      const input = AllowListMintInputSchema.parse(request.body);

      const base = {
        ownerId: deps.resolveOwnerId(request),
        walletId: input.walletId,
        nftContract: input.nftContract as `0x${string}`,
        chainId: input.chainId,
        quantity: input.quantity,
        source: request.sessionToken ? ('MANUAL' as const) : ('API' as const),
      };

      const req: AllowListMintRequest =
        input.proofSource === 'direct'
          ? { ...base, proofSource: 'direct', mintParams: toMintParams(input.mintParams), proof: input.proof as `0x${string}`[] }
          : input.proofSource === 'opensea'
            ? { ...base, proofSource: 'opensea', slug: input.slug }
            : { ...base, proofSource: 'stored', allowListId: input.allowListId };

      const outcome = await deps.mintExecutionService.executeAllowListMint(req);
      await deps.auditLogService?.record({
        actorUserId: base.ownerId,
        actorType: credentialActorType(request),
        action: 'mint.allowlist',
        walletId: input.walletId,
        outcome: outcome.ok ? 'success' : 'failure',
        detail: outcome.ok ? outcome.result.hash : outcome.reason,
      });
      return sendMintOutcome(reply, outcome);
    });
  };
