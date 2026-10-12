import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Logger } from '@stryx/logger';
import { DropsFeedError, type DropsFeedService } from './drops-feed.service.js';

export interface HomeControllerDeps {
  dropsFeedService: DropsFeedService;
  logger: Logger;
}

/** GET /home/drops?window=7d|30d: the Home page feed (OpenSea upcoming drops and recent mints, see drops-feed.service.ts). */
export const homeController: (deps: HomeControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerHomeRoutes(app: FastifyInstance) {
    app.get('/home/drops', async (request, reply) => {
      const parsed = z.object({ window: z.enum(['7d', '30d']).default('7d') }).safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_window', message: 'window must be 7d or 30d.' });
      const { window } = parsed.data;
      try {
        return reply.send(await deps.dropsFeedService.getFeed(window));
      } catch (err) {
        if (err instanceof DropsFeedError && err.code === 'no_api_key') {
          return reply.code(503).send({ error: 'feed_not_configured', message: err.message });
        }
        deps.logger.error('home drops feed failed', { message: err instanceof Error ? err.message : String(err) });
        return reply.code(502).send({ error: 'feed_unavailable', message: 'Could not load drops from OpenSea. Try again in a moment.' });
      }
    });
  };
