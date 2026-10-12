import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { InvalidCredentialsError, type UserAccountService } from '@stryx/user-service';
import type { UserId } from '@stryx/wallet-service';
import { tokensMatch } from './auth.js';
import type { StepUpStore } from './step-up-store.js';
import { SiweError, type SiweService } from './siwe-service.js';

const StepUpInputSchema = z.union([
  z.object({ credential: z.string().min(1) }),
  // A wallet-signed-in account has no password: it signs a "confirm" message instead (ADR-003 §4.2).
  z.object({ message: z.string().min(1).max(2000), signature: z.string().min(1).max(1000) }),
]);

export interface StepUpControllerDeps {
  store: StepUpStore;
  expectedToken: string;
  resolveOwnerId: (request: FastifyRequest) => UserId;
  userAccountService?: UserAccountService;
  /** Wallet sign-in on: a signed "confirm" message from one of the caller's own sign-in wallets also counts. */
  siwe?: SiweService;
}

/**
 * Re-proves the caller's identity for a sensitive action: retype the credential they signed in with,
 * or sign a message with their sign-in wallet. A short grant is then stored for that account.
 */
export const stepUpController: (deps: StepUpControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerStepUpRoutes(app: FastifyInstance) {
    app.post('/auth/step-up', async (request, reply) => {
      const input = StepUpInputSchema.parse(request.body);
      const ownerId = deps.resolveOwnerId(request);

      if ('message' in input) {
        if (!deps.siwe) return reply.code(401).send({ error: 'invalid_credential' });
        try {
          const verified = await deps.siwe.verify(input);
          // The message was issued to this account for one of its own sign-in wallets (see
          // /auth/siwe/confirm-challenge), and signed by that wallet.
          if (verified.purpose !== 'confirm' || verified.userId !== ownerId) return reply.code(401).send({ error: 'invalid_credential' });
        } catch (err) {
          if (err instanceof SiweError) return reply.code(401).send({ error: 'invalid_credential', message: err.message });
          throw err;
        }
      } else if (!request.sessionToken) {
        if (!tokensMatch(input.credential, deps.expectedToken)) {
          return reply.code(401).send({ error: 'invalid_credential' });
        }
      } else if (deps.userAccountService) {
        const user = await deps.userAccountService.getUserSummary(ownerId);
        if (!user || !user.email) return reply.code(401).send({ error: 'invalid_credential' });
        try {
          await deps.userAccountService.verifyCredentials(user.email, input.credential);
        } catch (err) {
          if (err instanceof InvalidCredentialsError) return reply.code(401).send({ error: 'invalid_credential' });
          throw err;
        }
      } else {
        return reply.code(401).send({ error: 'invalid_credential' });
      }

      await deps.store.grant(ownerId);
      return reply.send({ ok: true });
    });
  };

/** A sensitive route calls this first; it replies and returns false if there's no live grant. */
export async function requireStepUp(store: StepUpStore, ownerId: UserId, reply: FastifyReply): Promise<boolean> {
  if (await store.isGranted(ownerId)) return true;
  await reply.code(403).send({ error: 'step_up_required', message: 'Confirm it is you to continue.' });
  return false;
}

/** For an action each confirmation may do only once (revealing a key): the grant is used up by the check itself. */
export async function consumeStepUp(store: StepUpStore, ownerId: UserId, reply: FastifyReply): Promise<boolean> {
  if (await store.consume(ownerId)) return true;
  await reply.code(403).send({ error: 'step_up_required', message: 'Confirm it is you to continue.' });
  return false;
}
