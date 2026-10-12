import type { FastifyInstance } from 'fastify';
import type { Logger } from '@stryx/logger';
import { redactUrlsDeep, redactUrlsInKeys, redactUrlsKeepDomain } from '@stryx/utils';

/**
 * The one place that guarantees no URL leaves the API in an error message: error text from a chain or
 * HTTP client echoes the endpoint it called, often with an API key in it. Error responses have every
 * string scrubbed; successful ones only the keys that hold error text, since a 200 can carry real
 * URLs. What was redacted is logged server-side with each URL cut to its domain.
 */
export const ERROR_TEXT_KEYS: ReadonlySet<string> = new Set(['error', 'message', 'detail', 'failedReason', 'reason', 'stage']);

export function registerResponseRedaction(app: FastifyInstance, logger: Logger): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string') return payload;
    if (!String(reply.getHeader('content-type') ?? '').includes('application/json')) return payload;

    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return payload;
    }

    const scrubbed = reply.statusCode >= 400 ? redactUrlsDeep(body) : redactUrlsInKeys(body, ERROR_TEXT_KEYS);
    const next = JSON.stringify(scrubbed);
    if (next === JSON.stringify(body)) return payload;

    const logged = redactUrlsKeepDomain(payload);
    logger.warn('a URL was redacted from an API response; logged here with each URL cut to its domain', {
      method: request.method,
      route: request.routeOptions?.url ?? request.url.split('?')[0],
      statusCode: reply.statusCode,
      original: logged.length > 4000 ? `${logged.slice(0, 4000)}...` : logged,
    });
    reply.header('content-length', Buffer.byteLength(next));
    return next;
  });
}
