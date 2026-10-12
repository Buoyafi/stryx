import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserSummary } from '@stryx/user-service';
import type { AuditLogService } from './audit-log-service.js';
import type { RedisRateLimiter } from './rate-limiter.js';
import type { RedisSessionStore } from './session-store.js';
import type { StepUpStore } from './step-up-store.js';
import { requireStepUp } from './step-up-controller.js';
import { adminCaller } from './admin-guard.js';
import { CursorSchema, nextCursor } from './cursor.js';
import { AUDIT_CATEGORIES, WINDOW_MS, chainSummaries, mintTotals, seriesBuckets, timeSeries, type PlatformStatsRepository, type StatsWindow } from './platform-stats.js';

/** One member's page, and suspending or reactivating them (ADR-003 §4.10). */
export interface MemberAdminDeps {
  stepUp: StepUpStore;
  sessions: RedisSessionStore;
  setStatus: (id: string, status: 'ACTIVE' | 'SUSPENDED') => Promise<UserSummary | null>;
  /** Suspending also sets the account's emergency stop, so its scheduled mints cannot fire. */
  emergencyStop?: { triggerUserStop(userId: string, reason: string): Promise<void>; clearUserStop(userId: string): Promise<void> };
}

export interface AdminOverviewDeps {
  stats: PlatformStatsRepository;
  findUser: (id: string) => Promise<UserSummary | null>;
  auditLogService?: AuditLogService;
  /** Keeps "admin looked at user records" to one audit row per admin per 10 minutes, not one per poll. */
  limiter?: RedisRateLimiter;
  now?: () => number;
  /** With it, the member page and suspend/unsuspend routes exist. */
  members?: MemberAdminDeps;
}

const SuspendSchema = z.object({ reason: z.string().trim().max(200).optional() }).strict();

const WindowSchema = z.object({ window: z.enum(['24h', '7d', '30d']).default('7d') });
const PageSchema = (max: number, fallback: number) => z.object({ before: CursorSchema.optional(), limit: z.coerce.number().int().min(1).max(max).default(fallback) });
const AuditQuerySchema = PageSchema(200, 100).extend({ category: z.enum(Object.keys(AUDIT_CATEGORIES) as [string, ...string[]]).optional() });

const VIEW_LOG_SECONDS = 600;

/** The operator Overview (ADR-003 §4.10, §4.11), all under /admin and behind the one admin check. */
export const adminOverviewController: (deps: AdminOverviewDeps) => FastifyPluginAsync = (deps) =>
  async function registerAdminOverviewRoutes(app: FastifyInstance) {
    const now = deps.now ?? Date.now;

    const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<UserSummary | undefined> => {
      const admin = await adminCaller(request, deps.findUser);
      if (!admin) {
        await deps.auditLogService?.record({ actorUserId: request.userId ?? null, actorType: 'user', action: 'admin.denied', outcome: 'failure', detail: `${request.method} ${request.url.split('?')[0]}` });
        await reply.code(403).send({ error: 'forbidden', message: 'This needs an admin account.' });
        return undefined;
      }
      return admin;
    };

    const logView = async (admin: UserSummary, action: string, detail?: string) => {
      if (!deps.auditLogService) return;
      if (deps.limiter && !(await deps.limiter.hit(`admin-view:${action}`, admin.id, { limit: 1, windowSeconds: VIEW_LOG_SECONDS }))) return;
      await deps.auditLogService.record({ actorUserId: admin.id, actorType: 'admin', action, outcome: 'success', ...(detail ? { detail } : {}) });
    };

    app.get('/admin/overview', async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const { window } = WindowSchema.parse(request.query);
      const asOf = new Date(now());
      const since = new Date(asOf.getTime() - WINDOW_MS[window as StatsWindow]);
      const buckets = seriesBuckets(window as StatsWindow, asOf.getTime());
      const [statuses, chains, sources, collections, members, dataStartsAt, seriesRows] = await Promise.all([
        deps.stats.mintStatusCounts(since),
        deps.stats.mintsByChain(since),
        deps.stats.mintsBySource(since),
        deps.stats.topCollections(since, 10),
        deps.stats.memberCounts(since),
        deps.stats.dataStartsAt(),
        deps.stats.mintTimeseries(new Date(buckets.starts[0]!), buckets.unit),
      ]);
      return {
        asOf: asOf.toISOString(),
        window,
        since: since.toISOString(),
        dataStartsAt: dataStartsAt?.toISOString() ?? null,
        members,
        mints: mintTotals(statuses),
        chains: chainSummaries(chains),
        sources,
        collections,
        series: timeSeries(window as StatsWindow, asOf.getTime(), seriesRows, dataStartsAt),
      };
    });

    app.get('/admin/activity', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const q = PageSchema(100, 50).parse(request.query);
      const rows = await deps.stats.recentMints({ limit: q.limit, ...(q.before ? { before: q.before } : {}) });
      await logView(admin, 'admin.view_activity');
      return {
        mints: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        nextBefore: nextCursor(rows, q.limit),
      };
    });

    app.get('/admin/members', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const q = PageSchema(200, 100).parse(request.query);
      const rows = await deps.stats.members({ limit: q.limit, ...(q.before ? { before: q.before } : {}) });
      await logView(admin, 'admin.view_members');
      return {
        members: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), lastMintAt: r.lastMintAt?.toISOString() ?? null })),
        nextBefore: nextCursor(rows, q.limit),
      };
    });

    app.get('/admin/audit', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const q = AuditQuerySchema.parse(request.query);
      const rows = await deps.stats.audit({ limit: q.limit, ...(q.before ? { before: q.before } : {}), ...(q.category ? { prefixes: AUDIT_CATEGORIES[q.category] } : {}) });
      await logView(admin, 'admin.view_audit', q.category ? `category ${q.category}` : undefined);
      return {
        entries: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        nextBefore: nextCursor(rows, q.limit),
      };
    });

    const m = deps.members;
    if (!m) return;

    /** Admin, then a fresh confirmation; the target must exist. Replies and returns null otherwise. */
    const gate = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return null;
      if (!(await requireStepUp(m.stepUp, admin.id as never, reply))) return null;
      const member = await deps.findUser(request.params.id);
      if (!member) {
        await reply.code(404).send({ error: 'not_found', message: 'No such account.' });
        return null;
      }
      return { admin, member };
    };

    app.get<{ Params: { id: string } }>('/admin/members/:id', async (request, reply) => {
      const ok = await gate(request, reply);
      if (!ok) return;
      const detail = await deps.stats.memberDetail(ok.member.id, 25);
      await deps.auditLogService?.record({ actorUserId: ok.admin.id, actorType: 'admin', action: 'admin.view_user', targetUserId: ok.member.id, outcome: 'success' });
      const { passwordHash: _never, ...profile } = ok.member as typeof ok.member & { passwordHash?: unknown };
      return {
        member: profile,
        signInWallets: detail.signInWallets,
        wallets: detail.wallets,
        mints: mintTotals(detail.mintCounts),
        recentMints: detail.recentMints,
        audit: detail.audit,
      };
    });

    app.post<{ Params: { id: string } }>('/admin/members/:id/suspend', async (request, reply) => {
      const parsed = SuspendSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Keep the reason to 200 characters.' });
      const ok = await gate(request, reply);
      if (!ok) return;
      if (ok.member.id === ok.admin.id) return reply.code(409).send({ error: 'cannot_suspend_self', message: 'You cannot suspend your own account.' });
      if (ok.member.role === 'ADMIN') {
        return reply.code(409).send({ error: 'cannot_suspend_admin', message: 'This account is an admin. Make it a member first (npm run operator:revoke), then suspend it.' });
      }
      // Every step runs again on a repeat, so a suspension that failed half way is completed by
      // retrying.
      const already = ok.member.status === 'SUSPENDED';
      const reason = parsed.data.reason || null;
      if (!already) await m.setStatus(ok.member.id, 'SUSPENDED');
      // Shut out sessions first, stop anything scheduled from firing, then end every session it has.
      await m.sessions.blockUser(ok.member.id);
      await m.emergencyStop?.triggerUserStop(ok.member.id, `account suspended${reason ? `: ${reason}` : ''}`);
      const ended = await m.sessions.revokeAllForUser(ok.member.id);
      if (!already || ended > 0) {
        await deps.auditLogService?.record({
          actorUserId: ok.admin.id,
          actorType: 'admin',
          action: 'admin.suspend_user',
          targetUserId: ok.member.id,
          outcome: 'success',
          detail: `${already ? 'repeated; ' : ''}${reason ? `${reason}; ` : ''}${ended} session${ended === 1 ? '' : 's'} ended`,
        });
      }
      return reply.send({ status: 'SUSPENDED', sessionsEnded: ended });
    });

    app.post<{ Params: { id: string } }>('/admin/members/:id/unsuspend', async (request, reply) => {
      const ok = await gate(request, reply);
      if (!ok) return;
      const wasActive = ok.member.status === 'ACTIVE';
      if (!wasActive) await m.setStatus(ok.member.id, 'ACTIVE');
      // Lets it sign in again, and lifts the account's emergency stop too.
      await m.sessions.unblockUser(ok.member.id);
      if (wasActive) return reply.send({ status: 'ACTIVE' });
      await m.emergencyStop?.clearUserStop(ok.member.id);
      await deps.auditLogService?.record({ actorUserId: ok.admin.id, actorType: 'admin', action: 'admin.unsuspend_user', targetUserId: ok.member.id, outcome: 'success' });
      return reply.send({ status: 'ACTIVE' });
    });
  };
