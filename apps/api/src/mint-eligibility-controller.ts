import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserId } from '@stryx/wallet-service';
import type { MintEligibilityService } from './mint-eligibility.service.js';

const ParamsSchema = z.object({
  chainId: z.coerce.number().int().positive(),
  contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

const PhaseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(['public', 'allowlist']),
  priceWei: z.string().nullable(),
  startMs: z.number().int().nullable(),
  endMs: z.number().int().nullable(),
  maxPerWallet: z.number().int().nullable(),
  source: z.enum(['on-chain', 'opensea']),
  mechanism: z.enum(['merkle', 'signed', 'token-gated', 'unknown']).nullable(),
  openSeaStageUuid: z.string().nullable(),
});

const BodySchema = z.object({
  /** The collection's OpenSea slug, or null when it has no OpenSea listing at all: see CheckPhaseParams. */
  slug: z.string().min(1).nullable(),
  walletIds: z.array(z.string().min(1)).min(1).max(100),
  /** The exact Phase object the client already holds from GET .../phases: this route never re-derives it. */
  phase: PhaseSchema,
});

export interface MintEligibilityControllerDeps {
  mintEligibilityService: MintEligibilityService;
  resolveOwnerId: (request: FastifyRequest) => UserId;
}

/** Read-only, per-wallet eligibility for one phase. */
export const mintEligibilityController: (deps: MintEligibilityControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerMintEligibilityRoutes(app: FastifyInstance) {
    app.post('/chains/:chainId/collections/:contract/eligibility', async (request, reply) => {
      const { chainId, contract } = ParamsSchema.parse(request.params);
      const { slug, walletIds, phase } = BodySchema.parse(request.body);
      const ownerId = deps.resolveOwnerId(request);

      const outcome = await deps.mintEligibilityService.checkPhase({
        ownerId,
        nftContract: contract as `0x${string}`,
        chainId,
        phase,
        slug,
        walletIds,
      });

      if (outcome.preflightError) {
        return reply.code(400).send({ error: outcome.preflightError, message: outcome.detail });
      }
      return reply.code(200).send({ results: outcome.results });
    });
  };
