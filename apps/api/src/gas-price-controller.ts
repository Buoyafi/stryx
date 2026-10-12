import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Logger } from '@stryx/logger';
import type { GasPriceService } from './gas-price.service.js';

export interface GasPriceControllerDeps {
  gasPriceService: GasPriceService;
  /** Chains with an RPC configured on this instance. */
  configuredChainIds: readonly number[];
  logger: Logger;
}

/** GET /chains/:chainId/gas-price: read-only, served from a short server-side cache. */
export const gasPriceController: (deps: GasPriceControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerGasPriceRoutes(app: FastifyInstance) {
    app.get('/chains/:chainId/gas-price', async (request, reply) => {
      const { chainId } = z.object({ chainId: z.coerce.number().int().positive() }).parse(request.params);

      if (!deps.configuredChainIds.includes(chainId)) {
        return reply.code(400).send({ error: 'unsupported_chain', message: `chainId=${chainId} has no RPC configured on this instance.` });
      }

      try {
        const reading = await deps.gasPriceService.get(chainId);
        return reply.send({ chainId, gasPriceWei: reading.gasPriceWei.toString(), fetchedAt: reading.fetchedAt, cached: reading.cached });
      } catch (err) {
        deps.logger.error('gas price read failed', { chainId, message: err instanceof Error ? err.message : String(err) });
        return reply.code(502).send({ error: 'rpc_unavailable', message: 'Could not read the gas price from the chain.' });
      }
    });
  };
