import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditLogService } from './audit-log-service.js';
import { RESERVED_OPERATOR_USER_ID } from './reserved-users.js';
import type { TermsService } from './terms.js';

/** What an account that has not accepted the current terms may NOT do. */
export const TERMS_GATED: readonly { method: string; pattern: RegExp }[] = [
  { method: 'POST', pattern: /^\/mints\/seadrop\/(public|allowlist|batch)$/ },
  { method: 'POST', pattern: /^\/schedules\/mints(\/auto)?$/ },
  { method: 'PATCH', pattern: /^\/schedules\/mints\/[^/]+$/ },
  { method: 'POST', pattern: /^\/signed-mints$/ },
  { method: 'PUT', pattern: /^\/vault-settings$/ },
  { method: 'POST', pattern: /^\/wallets$/ },
  { method: 'POST', pattern: /^\/wallets\/bulk$/ },
  { method: 'POST', pattern: /^\/wallets\/import$/ },
];

export const TERMS_EXEMPT: readonly { method: string; pattern: RegExp }[] = [
  { method: '*', pattern: /^\/auth\// },
  { method: '*', pattern: /^\/me\/terms/ },
  { method: '*', pattern: /^\/admin\// },
  { method: 'POST', pattern: /^\/waitlist$/ },
  { method: 'POST', pattern: /^\/emergency-stop\/me$/ },
  { method: 'PATCH', pattern: /^\/me\/profile$/ },
  { method: 'POST', pattern: /^\/resolve\// },
  { method: 'POST', pattern: /^\/chains\// },
  { method: 'POST', pattern: /^\/mints\/seadrop\/preview$/ },
  { method: 'DELETE', pattern: /^\/schedules\/mints\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/signed-mints\/[^/]+$/ },
  { method: 'POST', pattern: /^\/wallets\/disperse$/ },
  { method: 'POST', pattern: /^\/wallets\/nfts\/transfer$/ },
  { method: 'POST', pattern: /^\/wallets\/[^/]+\/export-key$/ },
  { method: 'PATCH', pattern: /^\/wallets\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/wallets\/[^/]+$/ },
  { method: 'POST', pattern: /^\/wallets\/[^/]+\/(archive|unarchive|rotate-key)$/ },
];

const matches = (list: readonly { method: string; pattern: RegExp }[], method: string, path: string) => list.some((r) => (r.method === '*' || r.method === method) && r.pattern.test(path));
export const isTermsGated = (method: string, path: string) => matches(TERMS_GATED, method, path);
export const isTermsExempt = (method: string, path: string) => matches(TERMS_EXEMPT, method, path);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const AcceptSchema = z.object({ termsVersion: z.string().max(32), privacyVersion: z.string().max(32) }).strict();

export interface TermsControllerDeps {
  terms: TermsService;
  auditLogService?: AuditLogService;
}

const NOT_ACCEPTED = 'Please accept the updated Terms of Use and Privacy Policy to continue.';

const NOT_ACCEPTED_MESSAGE = NOT_ACCEPTED;

/**
 * The gate: while acceptance is on, a gated write (see TERMS_GATED) from an account that has not
 * accepted the current versions is a 403 `terms_not_accepted`.
 */
export function registerTermsGate(app: FastifyInstance, terms: TermsService): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!terms.required || SAFE_METHODS.has(request.method)) return;
    // The route as it was registered ("/wallets/:id"), never the URL text: the router decodes the URL
    // before matching, so an encoded path would slip past a text check.
    const route = request.routeOptions?.url;
    if (!route || !isTermsGated(request.method, route)) return;
    const userId = request.userId;
    if (!userId || userId === RESERVED_OPERATOR_USER_ID) return; // not signed in: the login check answers
    if (await terms.hasAccepted(userId)) return;
    return reply.code(403).send({ error: 'terms_not_accepted', message: NOT_ACCEPTED_MESSAGE, ...terms.versions() });
  });
}

/** Terms acceptance for signed-in accounts: read whether it is required and done, and accept the current versions. */
export const termsController: (deps: TermsControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerTermsRoutes(app: FastifyInstance) {
    const { terms } = deps;

    app.get('/me/terms', async (request, reply) => {
      const status = await terms.status(request.userId as string);
      return reply.send(status);
    });

    app.post('/me/terms/accept', async (request, reply) => {
      const userId = request.userId as string;
      if (!terms.required) return reply.code(404).send({ error: 'not_found', message: 'Terms acceptance is not turned on.' });
      const parsed = AcceptSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Send the termsVersion and privacyVersion you are accepting.' });
      if (!terms.matches(parsed.data)) {
        return reply.code(409).send({ error: 'terms_changed', message: 'The terms were updated. Please read the new version.', ...terms.versions() });
      }
      const wasAccepted = (await terms.status(userId)).accepted;
      if (!wasAccepted) {
        await terms.record(userId, 're_accept', metaOf(request));
        await deps.auditLogService?.record({ actorUserId: userId, actorType: 'user', action: 'terms.accept', outcome: 'success', detail: `terms ${parsed.data.termsVersion}, privacy ${parsed.data.privacyVersion}` });
      }
      return reply.send(await terms.status(userId));
    });
  };

export function metaOf(request: FastifyRequest): { ip: string | undefined; userAgent: string | undefined } {
  const ua = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof ua === 'string' ? ua : undefined };
}
