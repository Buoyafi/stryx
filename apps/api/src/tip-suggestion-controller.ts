import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { chainById } from '@stryx/chains';
import type { Logger } from '@stryx/logger';
import { MAX_PHASES, type TipSuggestionService } from './tip-suggestion.service.js';

export interface TipSuggestionControllerDeps {
  service: TipSuggestionService;
  /** Chains with an RPC configured on this instance. */
  configuredChainIds: readonly number[];
  logger: Logger;
}

const Query = z.object({
  contract: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  /** Earlier phases' start times, unix ms, comma separated: the page already holds them (GET .../phases). */
  starts: z
    .string()
    .regex(/^\d{1,15}(,\d{1,15})*$/)
    .optional(),
});

/**
 * GET /chains/:chainId/priority-fee/suggestion: the readings behind the tip field's Suggest button
 * (see tip-suggestion.service.ts).
 */
export const tipSuggestionController: (deps: TipSuggestionControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerTipSuggestionRoutes(app: FastifyInstance) {
    app.get('/chains/:chainId/priority-fee/suggestion', async (request, reply) => {
      const params = z.object({ chainId: z.coerce.number().int().positive() }).safeParse(request.params);
      const parsed = Query.safeParse(request.query);
      if (!params.success || !parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Expected a chain id, an optional 0x contract address, and optional start times in unix ms.' });
      }
      const { chainId } = params.data;
      const query = parsed.data;

      if (!deps.configuredChainIds.includes(chainId)) {
        return reply.code(400).send({ error: 'unsupported_chain', message: `chainId=${chainId} has no RPC configured on this instance.` });
      }
      const chain = chainById(chainId);
      if (!chain?.feeMarket.tipAffectsOrdering) {
        return reply.code(400).send({ error: 'tip_not_used', message: `${chain?.name ?? 'This chain'} takes transactions in arrival order, so a priority fee buys nothing there.` });
      }
      const starts = query.starts ? query.starts.split(',').map(Number) : [];
      if (starts.length > MAX_PHASES) {
        return reply.code(400).send({ error: 'too_many_phases', message: `At most ${MAX_PHASES} phases at a time.` });
      }

      try {
        const suggestion = await deps.service.suggest(chainId, (query.contract as `0x${string}` | undefined) ?? null, starts);
        if (!suggestion.network && suggestion.phases.every((p) => p.status === 'unavailable')) {
          return reply.code(502).send({ error: 'rpc_unavailable', message: 'Could not read recent tips from the chain.' });
        }
        return reply.send(suggestion);
      } catch (err) {
        deps.logger.error('tip suggestion failed', { chainId, message: err instanceof Error ? err.message : String(err) });
        return reply.code(502).send({ error: 'rpc_unavailable', message: 'Could not read recent tips from the chain.' });
      }
    });
  };
