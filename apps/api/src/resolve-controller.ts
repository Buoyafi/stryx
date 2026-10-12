import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { OpenSeaResolver, OpenSeaResolveError } from './opensea-resolver.js';
import type { ChainServices } from './chain-services.js';

const ResolveInputSchema = z.object({
  /** An OpenSea URL (collection or asset) or a bare collection slug. */
  input: z.string().min(1),
});

export interface ResolveControllerDeps {
  openSeaResolver: OpenSeaResolver;
  /** So the response can tell the caller whether the resolved chain is one this instance can actually mint on. */
  chainServices: Map<number, ChainServices>;
}

/** Resolves an OpenSea URL/slug to a contract + chain, and reports whether that chain is mintable on this instance. */
export const resolveController: (deps: ResolveControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerResolveRoutes(app: FastifyInstance) {
    app.post('/resolve/opensea', async (request, reply) => {
      const { input } = ResolveInputSchema.parse(request.body);

      try {
        const resolved = await deps.openSeaResolver.resolve(input);
        const mintableHere = resolved.chainId !== null && deps.chainServices.has(resolved.chainId);

        return reply.send({
          contract: resolved.contract,
          chainId: resolved.chainId,
          chainName: resolved.chainName,
          slug: resolved.slug,
          mintableHere,
          ...(resolved.chainId !== null && !mintableHere
            ? { note: `Resolved to chain ${resolved.chainName} (${resolved.chainId}), which has no RPC configured on this instance.` }
            : {}),
          ...(resolved.chainId === null
            ? { note: `Resolved to chain "${resolved.chainName}", which this platform does not support.` }
            : {}),
        });
      } catch (err) {
        if (err instanceof OpenSeaResolveError) {
          return reply.code(422).send({ error: 'resolve_failed', message: err.message });
        }
        throw err;
      }
    });
  };
