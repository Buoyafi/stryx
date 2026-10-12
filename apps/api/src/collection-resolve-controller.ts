import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Logger } from '@stryx/logger';
import { CollectionResolverService, CollectionResolveError, OpenSeaResolveError } from './collection-resolver.service.js';
import type { CollectionImageService } from './collection-image.service.js';
import type { CollectionSupplyService } from './collection-supply.service.js';
import { listPhases } from './collection-phases.service.js';
import type { OpenSeaDropInfo } from './opensea-drop-info.js';
import type { DropInfoReading } from './opensea-drop-info-cache.js';
import type { ChainServices } from './chain-services.js';

const ResolveInputSchema = z.object({
  /** An OpenSea collection/asset URL, a bare collection slug, or a bare 0x contract address. */
  input: z.string().min(1),
  /** Disambiguates a bare address that has code on more than one configured chain. */
  chainId: z.number().int().positive().optional(),
});

export interface CollectionResolveControllerDeps {
  collectionResolverService: CollectionResolverService;
  collectionImageService: CollectionImageService;
  collectionSupplyService: CollectionSupplyService;
  chainServices: ReadonlyMap<number, ChainServices>;
  fetchDropInfo: (chainId: number, contract: string) => Promise<OpenSeaDropInfo | null>;
  /** Optional: the same drop info plus why it may be missing. */
  fetchDropInfoReading?: (chainId: number, contract: string) => Promise<DropInfoReading>;
  logger: Logger;
}

/**
 * `POST /resolve/collection` accepts anything the operator might paste; `.../image` serves the image
 * resolved from contract data.
 */
export const collectionResolveController: (deps: CollectionResolveControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerCollectionResolveRoutes(app: FastifyInstance) {
    app.post('/resolve/collection', async (request, reply) => {
      const { input, chainId } = ResolveInputSchema.parse(request.body);

      try {
        const resolution = await deps.collectionResolverService.resolve(input, chainId);
        return reply.send(resolution);
      } catch (err) {
        if (err instanceof CollectionResolveError) {
          const status = err.code === 'contract_not_found' ? 404 : 400;
          return reply.code(status).send({ error: err.code, message: err.message });
        }
        if (err instanceof OpenSeaResolveError) {
          return reply.code(422).send({ error: 'resolve_failed', message: err.message });
        }
        throw err;
      }
    });

    app.get('/chains/:chainId/collections/:contract/image', async (request, reply) => {
      const { chainId, contract } = z
        .object({ chainId: z.coerce.number().int().positive(), contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/) })
        .parse(request.params);

      if (!deps.chainServices.has(chainId)) {
        return reply.code(400).send({ error: 'unsupported_chain', message: `chainId=${chainId} has no RPC configured on this instance.` });
      }

      try {
        const image = await deps.collectionImageService.get(chainId, contract as `0x${string}`);
        if (!image) return reply.code(404).send({ error: 'image_not_found' });
        // Long-cacheable: the service's own TTL governs freshness.
        return reply.header('content-type', image.contentType).header('cache-control', 'private, max-age=3600').send(Buffer.from(image.bytes));
      } catch (err) {
        deps.logger.error('collection image resolve failed', { chainId, contract, message: err instanceof Error ? err.message : String(err) });
        return reply.code(502).send({ error: 'image_unavailable', message: "Could not resolve this collection's image." });
      }
    });

    // What the header's progress bar polls, without re-running the full resolve.
    app.get('/chains/:chainId/collections/:contract/supply', async (request, reply) => {
      const { chainId, contract } = z
        .object({ chainId: z.coerce.number().int().positive(), contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/) })
        .parse(request.params);

      if (!deps.chainServices.has(chainId)) {
        return reply.code(400).send({ error: 'unsupported_chain', message: `chainId=${chainId} has no RPC configured on this instance.` });
      }

      try {
        const reading = await deps.collectionSupplyService.get(chainId, contract as `0x${string}`);
        return reply.send(reading);
      } catch (err) {
        deps.logger.error('collection supply read failed', { chainId, contract, message: err instanceof Error ? err.message : String(err) });
        return reply.code(502).send({ error: 'rpc_unavailable', message: "Could not read this collection's supply from the chain." });
      }
    });

    // Every phase of the drop (see collection-phases.service.ts).
    app.get('/chains/:chainId/collections/:contract/phases', async (request, reply) => {
      const { chainId, contract } = z
        .object({ chainId: z.coerce.number().int().positive(), contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/) })
        .parse(request.params);

      const services = deps.chainServices.get(chainId);
      if (!services) {
        return reply.code(400).send({ error: 'unsupported_chain', message: `chainId=${chainId} has no RPC configured on this instance.` });
      }

      try {
        const reading: DropInfoReading = deps.fetchDropInfoReading
          ? await deps.fetchDropInfoReading(chainId, contract).catch((): DropInfoReading => ({ info: null, openSea: 'unavailable' }))
          : { info: await deps.fetchDropInfo(chainId, contract).catch(() => null), openSea: 'ok' };
        const phases = await listPhases(chainId, contract as `0x${string}`, services, reading.info);
        if (reading.openSea === 'unavailable' || reading.openSea === 'stale') {
          deps.logger.warn('collection phases: OpenSea unreachable', { chainId, contract, openSea: reading.openSea });
        }
        return reply.send({ chainId, contract, phases, openSea: reading.openSea, ...(reading.asOf ? { openSeaAsOf: reading.asOf } : {}) });
      } catch (err) {
        deps.logger.error('collection phases read failed', { chainId, contract, message: err instanceof Error ? err.message : String(err) });
        return reply.code(502).send({ error: 'rpc_unavailable', message: "Could not read this collection's phases from the chain." });
      }
    });
  };
