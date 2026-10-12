import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Logger } from '@stryx/logger';
import type { NativePriceService } from './native-price.service.js';

export interface NativePriceControllerDeps {
  nativePriceService: NativePriceService;
  /** Chains with an RPC configured on this instance. */
  configuredChainIds: readonly number[];
  logger: Logger;
}

/** GET /chains/:chainId/native-price: the USD toggle's price feed (CoinGecko, cached). */
export const nativePriceController: (deps: NativePriceControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerNativePriceRoutes(app: FastifyInstance) {
    app.get('/chains/:chainId/native-price', async (request, reply) => {
      const { chainId } = z.object({ chainId: z.coerce.number().int().positive() }).parse(request.params);

      if (!deps.configuredChainIds.includes(chainId)) {
        return reply.code(400).send({ error: 'unsupported_chain', message: `chainId=${chainId} has no RPC configured on this instance.` });
      }

      try {
        const reading = await deps.nativePriceService.get(chainId);
        return reply.send(reading);
      } catch (err) {
        deps.logger.error('native price read failed', { chainId, message: err instanceof Error ? err.message : String(err) });
        return reply.code(502).send({ error: 'price_unavailable', message: 'Could not read a USD price for this chain.' });
      }
    });
  };
