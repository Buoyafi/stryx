import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  SignupInputSchema,
  ProfileUpdateSchema,
  LoginInputSchema,
  type UserAccountService,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
} from '@stryx/user-service';
import type { RedisSessionStore } from './session-store.js';
import type { AuditLogService } from './audit-log-service.js';
import type { SessionCookie } from './session-cookie.js';
import type { IdentityRepository } from './identity-repository.js';
import { lifetimeForRole } from './session-store.js';
import { credentialActorType } from './audit-actor.js';

export interface UserAuthControllerDeps {
  userAccountService: UserAccountService;
  sessions: RedisSessionStore;
  /** ADR-002 §3.10. Optional so tests that don't care about audit logging don't need it wired up. */
  auditLogService?: AuditLogService;
  /** Whether POST /auth/signup is open. */
  signupEnabled?: boolean;
  /** Wallet sign-in on: logout also clears the session cookie, and /auth/me lists the sign-in wallets. */
  sessionCookie?: SessionCookie;
  identity?: IdentityRepository;
}

/** Account creation and session lifecycle (ADR-002 §3.4). */
export const userAuthController: (deps: UserAuthControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerUserAuthRoutes(app: FastifyInstance) {
    app.post('/auth/signup', async (request, reply) => {
      if (!deps.signupEnabled) {
        await deps.auditLogService?.record({
          actorUserId: null,
          actorType: 'user',
          action: 'session.signup',
          outcome: 'failure',
          detail: 'signup is disabled (SIGNUP_ENABLED is not set)',
        });
        return reply.code(403).send({
          error: 'signup_disabled',
          message: 'Account creation is currently closed.',
        });
      }

      const input = SignupInputSchema.parse(request.body);
      try {
        const user = await deps.userAccountService.signup(input);
        const token = await deps.sessions.create(user.id);
        await deps.auditLogService?.record({
          actorUserId: user.id,
          actorType: 'user',
          action: 'session.signup',
          outcome: 'success',
        });
        return reply.code(201).send({ token, user });
      } catch (err) {
        if (err instanceof EmailAlreadyRegisteredError) {
          await deps.auditLogService?.record({
            actorUserId: null,
            actorType: 'user',
            action: 'session.signup',
            outcome: 'failure',
            detail: err.message,
          });
          return reply.code(409).send({ error: 'email_already_registered', message: err.message });
        }
        throw err;
      }
    });

    app.post('/auth/login', async (request, reply) => {
      const input = LoginInputSchema.parse(request.body);
      try {
        const user = await deps.userAccountService.verifyCredentials(input.email, input.password);
        const token = await deps.sessions.create(user.id, lifetimeForRole(user.role));
        await deps.auditLogService?.record({
          actorUserId: user.id,
          actorType: user.role === 'ADMIN' ? 'admin' : 'user',
          action: 'session.login',
          outcome: 'success',
        });
        return reply.send({ token, user });
      } catch (err) {
        if (err instanceof InvalidCredentialsError) {
          // No actorUserId: resolving the email to a user on a failed login would be the very
          // enumeration the shared error avoids.
          await deps.auditLogService?.record({
            actorUserId: null,
            actorType: 'user',
            action: 'session.login',
            outcome: 'failure',
            detail: err.message,
          });
          return reply.code(401).send({ error: 'invalid_credentials', message: err.message });
        }
        throw err;
      }
    });

    // Requires auth: only a presented session can be logged out.
    app.post('/auth/logout', async (request, reply) => {
      // A request made with the operator token has no session to revoke.
      if (request.sessionToken) {
        await deps.sessions.revoke(request.sessionToken);
      }
      if (deps.sessionCookie) reply.header('set-cookie', deps.sessionCookie.clear());
      await deps.auditLogService?.record({
        actorUserId: request.userId ?? null,
        actorType: credentialActorType(request),
        action: 'session.logout',
        outcome: 'success',
      });
      return reply.code(204).send();
    });

    // "Sign out everywhere": ends every session this account has.
    app.post('/auth/logout-everywhere', async (request, reply) => {
      const userId = request.userId as string;
      const ended = await deps.sessions.revokeAllForUser(userId);
      if (deps.sessionCookie) reply.header('set-cookie', deps.sessionCookie.clear());
      await deps.auditLogService?.record({
        actorUserId: userId,
        actorType: credentialActorType(request),
        action: 'session.logout_all',
        outcome: 'success',
        detail: `${ended} session${ended === 1 ? '' : 's'} ended`,
      });
      return reply.send({ ended });
    });

    // Also requires auth.
    app.get('/auth/me', async (request, reply) => {
      const user = await deps.userAccountService.getUserSummary(request.userId as string);
      if (!user) return reply.code(404).send({ error: 'user_not_found' });
      // How this request signed in: the operator token, a password session, or a wallet session.
      const signInWallets = deps.identity ? await deps.identity.listSignInWallets(user.id) : [];
      const signedInWith = !request.sessionToken ? 'token' : signInWallets.length > 0 ? 'wallet' : 'password';
      return reply.send({ ...user, signedInWith, signInAddresses: signInWallets.map((w) => w.address) });
    });

    // The signed-in user's own profile handles (Discord, X).
    app.patch('/me/profile', async (request, reply) => {
      const parsed = ProfileUpdateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_profile', message: parsed.error.issues[0]?.message ?? 'Check the handles and try again.' });
      }
      const user = await deps.userAccountService.updateProfile(request.userId as string, parsed.data);
      if (!user) return reply.code(404).send({ error: 'user_not_found' });
      await deps.auditLogService?.record({
        actorUserId: request.userId ?? null,
        actorType: user.role === 'ADMIN' ? 'admin' : 'user',
        action: 'profile.update',
        outcome: 'success',
      });
      return reply.send(user);
    });
  };
