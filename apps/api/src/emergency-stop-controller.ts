import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserId } from '@stryx/wallet-service';
import type { EmergencyStopGuard } from '@stryx/transaction-engine';
import type { UserRepository } from '@stryx/user-service';
import type { AuditLogService } from './audit-log-service.js';
import { adminCaller } from './admin-guard.js';

const TriggerInputSchema = z.object({ reason: z.string().min(1) });
const ClearInputSchema = z.object({ reason: z.string().min(1).optional() });
const WalletParamSchema = z.object({ walletId: z.string().min(1) });
const UserParamSchema = z.object({ userId: z.string().min(1) });

export interface EmergencyStopControllerDeps {
  emergencyStopGuard: EmergencyStopGuard;
  /** Used only to check the caller's role for the admin-gated routes below: no other route in this controller needs it. */
  userRepository: UserRepository;
  resolveOwnerId: (request: FastifyRequest) => UserId;
  /** ADR-002 §3.10. Optional so tests that don't care about audit logging don't need it wired up. */
  auditLogService?: AuditLogService;
}

/** The emergency-stop routes: a user's own stop, and the admin's per-user and global stops. Only an admin lifts a stop. */
export const emergencyStopController: (deps: EmergencyStopControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerEmergencyStopRoutes(app: FastifyInstance) {
    /** Returns the caller's id if they're ADMIN, otherwise replies 403 and returns undefined. */
    async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<UserId | undefined> {
      const callerId = deps.resolveOwnerId(request);
      const caller = await deps.userRepository.findById(callerId);
      if (!(await adminCaller(request, async () => caller))) {
        await deps.auditLogService?.record({
          actorUserId: callerId,
          actorType: 'user',
          action: 'emergency_stop.admin_action_denied',
          outcome: 'failure',
          detail: `role=${caller?.role ?? 'unknown'} attempted an admin-only emergency-stop action at ${request.method} ${request.url}`,
        });
        await reply.code(403).send({ error: 'forbidden', message: 'This action requires the ADMIN role.' });
        return undefined;
      }
      return callerId;
    }

    // --- Self-service: trigger only, never clear (see file header) ---
    app.post('/emergency-stop/me', async (request, reply) => {
      const input = TriggerInputSchema.parse(request.body);
      const ownerId = deps.resolveOwnerId(request);
      await deps.emergencyStopGuard.triggerUserStop(ownerId, input.reason);
      await deps.auditLogService?.record({
        actorUserId: ownerId,
        actorType: 'user',
        action: 'emergency_stop.trigger.user',
        targetUserId: ownerId,
        outcome: 'success',
        detail: input.reason,
      });
      return reply.code(200).send({ scope: 'user', userId: ownerId, status: 'stopped' });
    });

    // --- Admin: global ---
    app.post('/admin/emergency-stop/global', async (request, reply) => {
      const callerId = await requireAdmin(request, reply);
      if (!callerId) return;
      const input = TriggerInputSchema.parse(request.body);
      await deps.emergencyStopGuard.triggerGlobalStop(input.reason);
      await deps.auditLogService?.record({
        actorUserId: callerId,
        actorType: 'admin',
        action: 'emergency_stop.trigger.global',
        outcome: 'success',
        detail: input.reason,
      });
      return reply.code(200).send({ scope: 'global', status: 'stopped' });
    });

    app.delete('/admin/emergency-stop/global', async (request, reply) => {
      const callerId = await requireAdmin(request, reply);
      if (!callerId) return;
      const input = ClearInputSchema.parse(request.body ?? {});
      await deps.emergencyStopGuard.clearGlobalStop();
      await deps.auditLogService?.record({
        actorUserId: callerId,
        actorType: 'admin',
        action: 'emergency_stop.clear.global',
        outcome: 'success',
        detail: input.reason ?? null,
      });
      return reply.code(200).send({ scope: 'global', status: 'cleared' });
    });

    // --- Admin: a specific wallet ---
    app.post('/admin/emergency-stop/wallets/:walletId', async (request, reply) => {
      const callerId = await requireAdmin(request, reply);
      if (!callerId) return;
      const { walletId } = WalletParamSchema.parse(request.params);
      const input = TriggerInputSchema.parse(request.body);
      await deps.emergencyStopGuard.triggerWalletStop(walletId, input.reason);
      await deps.auditLogService?.record({
        actorUserId: callerId,
        actorType: 'admin',
        action: 'emergency_stop.trigger.wallet',
        walletId,
        outcome: 'success',
        detail: input.reason,
      });
      return reply.code(200).send({ scope: 'wallet', walletId, status: 'stopped' });
    });

    app.delete('/admin/emergency-stop/wallets/:walletId', async (request, reply) => {
      const callerId = await requireAdmin(request, reply);
      if (!callerId) return;
      const { walletId } = WalletParamSchema.parse(request.params);
      const input = ClearInputSchema.parse(request.body ?? {});
      await deps.emergencyStopGuard.clearWalletStop(walletId);
      await deps.auditLogService?.record({
        actorUserId: callerId,
        actorType: 'admin',
        action: 'emergency_stop.clear.wallet',
        walletId,
        outcome: 'success',
        detail: input.reason ?? null,
      });
      return reply.code(200).send({ scope: 'wallet', walletId, status: 'cleared' });
    });

    // Admin: one user's whole account. The only way a user-scoped stop is lifted, including one the
    // user set.
    app.post('/admin/emergency-stop/users/:userId', async (request, reply) => {
      const callerId = await requireAdmin(request, reply);
      if (!callerId) return;
      const { userId } = UserParamSchema.parse(request.params);
      const input = TriggerInputSchema.parse(request.body);
      await deps.emergencyStopGuard.triggerUserStop(userId, input.reason);
      await deps.auditLogService?.record({
        actorUserId: callerId,
        actorType: 'admin',
        action: 'emergency_stop.trigger.user',
        targetUserId: userId,
        outcome: 'success',
        detail: input.reason,
      });
      return reply.code(200).send({ scope: 'user', userId, status: 'stopped' });
    });

    app.delete('/admin/emergency-stop/users/:userId', async (request, reply) => {
      const callerId = await requireAdmin(request, reply);
      if (!callerId) return;
      const { userId } = UserParamSchema.parse(request.params);
      const input = ClearInputSchema.parse(request.body ?? {});
      await deps.emergencyStopGuard.clearUserStop(userId);
      await deps.auditLogService?.record({
        actorUserId: callerId,
        actorType: 'admin',
        action: 'emergency_stop.clear.user',
        targetUserId: userId,
        outcome: 'success',
        detail: input.reason ?? null,
      });
      return reply.code(200).send({ scope: 'user', userId, status: 'cleared' });
    });
  };
