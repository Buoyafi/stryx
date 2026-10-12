import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAddress, isAddress } from 'viem';
import type { UserAccountService, UserSummary } from '@stryx/user-service';
import type { RedisSessionStore } from './session-store.js';
import type { SessionCookie } from './session-cookie.js';
import type { AuditLogService } from './audit-log-service.js';
import type { RedisRateLimiter, RateLimitRule } from './rate-limiter.js';
import { SiweError, type SiweService } from './siwe-service.js';
import type { AccessCodeService } from './access-code-service.js';
import { codeUsable, type AccessCodeListItem, type IdentityRepository } from './identity-repository.js';
import { adminCaller } from './admin-guard.js';
import { lifetimeForRole } from './session-store.js';
import { metaOf } from './terms-controller.js';
import type { TermsService } from './terms.js';

/**
 * Invite code first, then wallet sign-in (ADR-003 §4.1, §4.4). A usable code is held for the visitor
 * for 15 minutes; the wallet then signs a challenge, and verifying it signs in an existing account or
 * creates one and uses the code up.
 */
/** The page's origin, for the sign-in message to name (SiweService uses it only when APP_ORIGIN lists it). */
function originOf(request: { headers: Record<string, unknown> }): { origin?: string } {
  const origin = request.headers['origin'];
  return typeof origin === 'string' ? { origin } : {};
}

export interface WalletAuthControllerDeps {
  siwe: SiweService;
  codes: AccessCodeService;
  identity: IdentityRepository;
  sessions: RedisSessionStore;
  sessionCookie: SessionCookie;
  userAccountService: UserAccountService;
  limiter: RedisRateLimiter;
  /** With terms acceptance on, a new account must send `acceptedTerms` to be made. */
  terms?: TermsService;
  auditLogService?: AuditLogService;
  now?: () => Date;
}

const LIMITS: Record<'code' | 'challenge' | 'verify' | 'confirm', RateLimitRule> = {
  code: { limit: 10, windowSeconds: 15 * 60 },
  challenge: { limit: 30, windowSeconds: 10 * 60 },
  verify: { limit: 30, windowSeconds: 15 * 60 },
  confirm: { limit: 30, windowSeconds: 10 * 60 },
};

const CodeCheckSchema = z.object({ code: z.string().max(64) });
const ChallengeSchema = z.object({ address: z.string().max(64), chainId: z.number().int().positive() });
const VerifySchema = z.object({
  message: z.string().min(1).max(2000),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/).max(1000),
  ticket: z.string().max(100).optional(),
  // The versions the visitor ticked the box for (sign-up only; ignored when signing in to an existing account).
  acceptedTerms: z.object({ termsVersion: z.string().max(32), privacyVersion: z.string().max(32) }).optional(),
});
const CreateCodeSchema = z
  .object({
    label: z.string().trim().max(80).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
    boundAddress: z.string().max(64).optional(),
  })
  .strict();

const CODE_INVALID = 'That code is not valid or was already used.';
const TOO_MANY = 'Too many tries. Wait a few minutes, then try again.';

function codeStatus(code: AccessCodeListItem, now: Date): 'unused' | 'used' | 'revoked' | 'expired' {
  if (code.redeemedAt) return 'used';
  if (code.revokedAt) return 'revoked';
  return codeUsable(code, now) ? 'unused' : 'expired';
}

export const walletAuthController: (deps: WalletAuthControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerWalletAuthRoutes(app: FastifyInstance) {
    const now = deps.now ?? (() => new Date());
    const audit = deps.auditLogService;

    const limited = async (reply: FastifyReply, bucket: keyof typeof LIMITS, subject: string): Promise<boolean> => {
      if (await deps.limiter.hit(bucket, subject, LIMITS[bucket])) return false;
      await reply.code(429).send({ error: 'rate_limited', message: TOO_MANY });
      return true;
    };
    const bad = (reply: FastifyReply, message: string) => reply.code(400).send({ error: 'invalid_request', message });

    const signInResponse = async (reply: FastifyReply, userId: string, status: number, created: boolean) => {
      const user = await deps.userAccountService.getUserSummary(userId);
      // An admin's session is short (ADR-003 §4.10): 1 hour idle, 12 hours at most.
      const lifetime = user ? lifetimeForRole(user.role) : undefined;
      const token = await deps.sessions.create(userId, lifetime);
      reply.header('set-cookie', deps.sessionCookie.serialize(token, lifetime ? Math.floor(lifetime.maxAgeMs / 1000) : undefined));
      return reply.code(status).send({ user, created });
    };

    // Lets the dashboard know it can offer the invite-code front door.
    app.get('/auth/options', async () => ({ walletSignIn: true, terms: deps.terms?.versions() ?? null }));

    app.post('/auth/code/check', async (request, reply) => {
      if (await limited(reply, 'code', request.ip)) return;
      const parsed = CodeCheckSchema.safeParse(request.body);
      if (!parsed.success) return bad(reply, CODE_INVALID);
      const result = await deps.codes.check(parsed.data.code);
      if (result === 'invalid') {
        await audit?.record({ actorUserId: null, actorType: 'user', action: 'access_code.check', outcome: 'failure', detail: 'not usable' });
        return reply.code(400).send({ error: 'code_invalid', message: CODE_INVALID });
      }
      if (result === 'held') {
        return reply.code(409).send({ error: 'code_held', message: 'Someone is using this code right now. Try again in 15 minutes.' });
      }
      await audit?.record({ actorUserId: null, actorType: 'user', action: 'access_code.check', outcome: 'success', detail: `code ${result.codeId} held` });
      return reply.send({ ticket: result.ticket, expiresInSeconds: result.expiresInSeconds });
    });

    app.post('/auth/siwe/challenge', async (request, reply) => {
      if (await limited(reply, 'challenge', request.ip)) return;
      const parsed = ChallengeSchema.safeParse(request.body);
      if (!parsed.success) return bad(reply, 'Connect a wallet, then try again.');
      try {
        // Not under `message`: response redaction scrubs URLs from keys named for error text, and this
        // text must reach the wallet exactly as issued.
        const { message } = await deps.siwe.challenge({ ...parsed.data, purpose: 'sign-in', ...originOf(request) });
        return reply.send({ siweMessage: message });
      } catch (err) {
        if (err instanceof SiweError) return bad(reply, err.message);
        throw err;
      }
    });

    app.post('/auth/siwe/verify', async (request, reply) => {
      if (await limited(reply, 'verify', request.ip)) return;
      const parsed = VerifySchema.safeParse(request.body);
      if (!parsed.success) return bad(reply, 'That sign-in request is not valid. Start again.');
      const { message, signature, ticket, acceptedTerms } = parsed.data;

      let verified;
      try {
        verified = await deps.siwe.verify({ message, signature });
      } catch (err) {
        if (err instanceof SiweError) {
          await audit?.record({ actorUserId: null, actorType: 'user', action: 'session.login_wallet', outcome: 'failure', detail: err.code });
          return reply.code(401).send({ error: err.code, message: err.message });
        }
        throw err;
      }
      if (verified.purpose !== 'sign-in') return bad(reply, 'That sign-in request is not valid. Start again.');
      const at = now();

      // A wallet that already has an account: plain sign-in, no code needed again.
      const existing = await deps.identity.findSignInWallet(verified.address.toLowerCase());
      if (existing) {
        const user = await deps.userAccountService.getUserSummary(existing.userId);
        if (!user || user.status !== 'ACTIVE') {
          await audit?.record({ actorUserId: existing.userId, actorType: 'user', action: 'session.login_wallet', outcome: 'failure', detail: 'account not active' });
          return reply.code(403).send({ error: 'account_unavailable', message: "This account can't sign in right now." });
        }
        await deps.identity.touchSignInWallet(existing.id, at);
        await audit?.record({ actorUserId: user.id, actorType: user.role === 'ADMIN' ? 'admin' : 'user', action: 'session.login_wallet', outcome: 'success' });
        return signInResponse(reply, user.id, 200, false);
      }

      // A new wallet: only with a code this visitor is holding.
      if (!ticket) return reply.code(403).send({ error: 'code_required', message: 'This wallet has no account yet. Enter your invite code first.' });
      const codeId = await deps.codes.resolveTicket(ticket);
      if (!codeId) return reply.code(403).send({ error: 'code_expired', message: 'Your code hold ran out. Enter the code again.' });
      const code = await deps.identity.findAccessCodeById(codeId);
      if (!code || !codeUsable(code, at)) {
        await deps.codes.release(ticket, codeId);
        return reply.code(403).send({ error: 'code_invalid', message: CODE_INVALID });
      }
      if (code.boundAddressLower && code.boundAddressLower !== verified.address.toLowerCase()) {
        return reply.code(403).send({ error: 'code_wrong_wallet', message: 'This code is for a different wallet.' });
      }

      // With terms acceptance on, an account is made only for someone who accepted the versions in
      // force.
      if (deps.terms?.required && !deps.terms.matches(acceptedTerms)) {
        return reply.code(400).send({ error: 'terms_required', message: 'Please accept the Terms of Use and Privacy Policy to create your account.', ...deps.terms.versions() });
      }

      const result = await deps.identity.redeemAndCreateAccount({ codeId, address: getAddress(verified.address), chainId: verified.chainId, now: at });
      if (result === 'code_unusable') {
        await deps.codes.release(ticket, codeId);
        return reply.code(403).send({ error: 'code_invalid', message: CODE_INVALID });
      }
      if (result === 'wallet_taken') {
        return reply.code(409).send({ error: 'wallet_taken', message: 'This wallet already has an account. Sign in again.' });
      }
      await deps.codes.release(ticket, codeId);
      if (deps.terms?.required) {
        await deps.terms.record(result.userId, 'sign_up', metaOf(request));
        await audit?.record({ actorUserId: result.userId, actorType: 'user', action: 'terms.accept', targetUserId: result.userId, outcome: 'success', detail: `terms ${acceptedTerms?.termsVersion}, privacy ${acceptedTerms?.privacyVersion} (sign-up)` });
      }
      await audit?.record({ actorUserId: result.userId, actorType: 'user', action: 'account.create_wallet', targetUserId: result.userId, outcome: 'success', detail: `access code ${codeId}` });
      return signInResponse(reply, result.userId, 201, true);
    });

    // Signed in: a "confirm" message for one of this account's own sign-in wallets (step-up).
    app.post('/auth/siwe/confirm-challenge', async (request, reply) => {
      const userId = request.userId as string;
      if (await limited(reply, 'confirm', userId)) return;
      const parsed = ChallengeSchema.safeParse(request.body);
      if (!parsed.success || !isAddress(parsed.data.address, { strict: false })) return bad(reply, 'Connect the wallet you signed in with, then try again.');
      const wallet = await deps.identity.findSignInWallet(parsed.data.address.toLowerCase());
      if (!wallet || wallet.userId !== userId) {
        return reply.code(403).send({ error: 'not_your_wallet', message: 'Use the wallet you signed in with.' });
      }
      try {
        const { message } = await deps.siwe.challenge({ ...parsed.data, purpose: 'confirm', userId, ...originOf(request) });
        return reply.send({ siweMessage: message });
      } catch (err) {
        if (err instanceof SiweError) return bad(reply, err.message);
        throw err;
      }
    });

    // --- Admin: invite codes ---------------------------------------------------------------

    const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<UserSummary | undefined> => {
      const caller = await adminCaller(request, (id) => deps.userAccountService.getUserSummary(id));
      if (!caller) {
        await audit?.record({ actorUserId: request.userId ?? null, actorType: 'user', action: 'admin.denied', outcome: 'failure', detail: `${request.method} ${request.url.split('?')[0]}` });
        await reply.code(403).send({ error: 'forbidden', message: 'This needs an admin account.' });
        return undefined;
      }
      return caller;
    };

    app.get('/admin/access-codes', async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const at = now();
      const codes = await deps.identity.listAccessCodes(500);
      return reply.send({
        codes: codes.map((c) => ({
          id: c.id,
          label: c.label,
          status: codeStatus(c, at),
          boundAddress: c.boundAddressLower ? getAddress(c.boundAddressLower) : null,
          expiresAt: c.expiresAt,
          createdAt: c.createdAt,
          redeemedAt: c.redeemedAt,
          redeemedByAddress: c.redeemedByAddress,
          revokedAt: c.revokedAt,
        })),
      });
    });

    app.post('/admin/access-codes', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const parsed = CreateCodeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return bad(reply, 'Check the label (80 characters at most) and the expiry (1 to 365 days).');
      const { label, expiresInDays, boundAddress } = parsed.data;
      if (boundAddress && !isAddress(boundAddress, { strict: true })) return bad(reply, 'That wallet address is not valid.');
      const { code, record } = await deps.codes.create({ label: label || null, createdById: admin.id, boundAddress: boundAddress ?? null, expiresInDays: expiresInDays ?? null });
      await audit?.record({ actorUserId: admin.id, actorType: 'admin', action: 'access_code.create', outcome: 'success', detail: `code ${record.id}` });
      // The only time the code itself is ever sent anywhere: it is not stored.
      return reply.code(201).send({ code, id: record.id, expiresAt: record.expiresAt });
    });

    app.post<{ Params: { id: string } }>('/admin/access-codes/:id/revoke', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const result = await deps.identity.revokeAccessCode(request.params.id, now());
      await audit?.record({ actorUserId: admin.id, actorType: 'admin', action: 'access_code.revoke', outcome: result === 'revoked' ? 'success' : 'failure', detail: `code ${request.params.id}: ${result}` });
      if (result === 'not_found') return reply.code(404).send({ error: 'not_found', message: 'No such code.' });
      if (result === 'already_used') return reply.code(409).send({ error: 'already_used', message: 'This code was already used, so it cannot be revoked.' });
      return reply.send({ ok: true });
    });
  };
