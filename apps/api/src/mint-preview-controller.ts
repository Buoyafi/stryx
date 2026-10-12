import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserId } from '@stryx/wallet-service';
import type { MintPreviewService, PreviewRequest } from './mint-preview.service.js';

const BaseFields = {
  nftContract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().positive(),
  walletIds: z.array(z.string().min(1)).min(1).max(100),
};

// A plain union with a nested discriminated union: 'allowlist' has two shapes, and zod rejects a
// duplicate discriminator value.
const PreviewInputSchema = z.union([
  z.object({ ...BaseFields, stage: z.literal('public') }),
  z.discriminatedUnion('proofSource', [
    z.object({ ...BaseFields, stage: z.literal('allowlist'), proofSource: z.literal('opensea'), slug: z.string().min(1) }),
    z.object({ ...BaseFields, stage: z.literal('allowlist'), proofSource: z.literal('stored'), allowListId: z.string().min(1) }),
  ]),
]);

export interface MintPreviewControllerDeps {
  mintPreviewService: MintPreviewService;
  resolveOwnerId: (request: FastifyRequest) => UserId;
}

/** Thin HTTP wrapper over MintPreviewService. Read-only, so nothing is audit-logged. */
export const mintPreviewController: (deps: MintPreviewControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerMintPreviewRoutes(app: FastifyInstance) {
    app.post('/mints/seadrop/preview', async (request, reply) => {
      const input = PreviewInputSchema.parse(request.body);
      const ownerId = deps.resolveOwnerId(request);

      const req: PreviewRequest =
        input.stage === 'public'
          ? { ownerId, nftContract: input.nftContract as `0x${string}`, chainId: input.chainId, walletIds: input.walletIds, stage: 'public' }
          : input.proofSource === 'opensea'
            ? { ownerId, nftContract: input.nftContract as `0x${string}`, chainId: input.chainId, walletIds: input.walletIds, stage: 'allowlist', proofSource: 'opensea', slug: input.slug }
            : { ownerId, nftContract: input.nftContract as `0x${string}`, chainId: input.chainId, walletIds: input.walletIds, stage: 'allowlist', proofSource: 'stored', allowListId: input.allowListId };

      const outcome = await deps.mintPreviewService.preview(req);

      if (outcome.preflightError) {
        return reply.code(400).send({ error: outcome.preflightError, message: outcome.detail });
      }
      return reply.code(200).send({ results: outcome.results });
    });
  };
