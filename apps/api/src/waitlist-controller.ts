import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserSummary } from '@stryx/user-service';
import type { AuditLogService } from './audit-log-service.js';
import type { RedisRateLimiter, RateLimitRule } from './rate-limiter.js';
import { adminCaller } from './admin-guard.js';
import { inviteEmail, type Mailer } from './invite-email.js';
import { waitlistCsv, type WaitlistRow, type WaitlistService, type WaitlistStatus } from './waitlist.js';

export interface WaitlistControllerDeps {
  service: WaitlistService;
  limiter: RedisRateLimiter;
  /** With it, the admin routes exist. Without it only the public sign-up does. */
  findUser?: (id: string) => Promise<UserSummary | null>;
  auditLogService?: AuditLogService;
  /** With it, `POST /admin/waitlist/:id/send-invite` makes the person a code and emails it. */
  invites?: InviteSending;
}

export interface InviteSending {
  createCode(input: { label: string; createdById: string; expiresInDays: number }): Promise<{ code: string; id: string; expiresAt: Date }>;
  /** Takes back a code whose email never went out. */
  revokeCode(id: string): Promise<unknown>;
  mailer: Mailer;
  appUrl: string;
  siteUrl: string;
  xUrl: string;
}

/** How long an emailed invite code lasts. An admin can revoke it sooner (Invite codes tab). */
export const INVITE_CODE_DAYS = 14;

/** Per visitor, and across everyone, so a flood from many addresses cannot fill the table either. */
const LIMITS: Record<'visitor' | 'everyone', RateLimitRule> = {
  visitor: { limit: 5, windowSeconds: 3600 },
  everyone: { limit: 600, windowSeconds: 3600 },
};

const VIEW_LOG_SECONDS = 600;
const TOO_MANY = 'Too many tries. Try again a little later.';
const BAD_EMAIL = 'Enter a valid email address.';

// `leave_blank` is a trap: the form hides it, so a person never fills it in and a script usually does.
const JoinSchema = z.object({ email: z.unknown(), leave_blank: z.unknown().optional() }).passthrough();
const ListQuery = z.object({ status: z.enum(['all', 'waiting', 'invited']).default('all') });
const InvitedBody = z.object({ invited: z.boolean() }).strict();

const wire = (r: WaitlistRow) => ({ id: r.id, email: r.email, status: r.status.toLowerCase() as Lowercase<WaitlistStatus>, note: r.note, invitedAt: r.invitedAt, createdAt: r.createdAt });

/**
 * The waitlist. `POST /waitlist` is public, for the landing page, and always answers `{ ok: true }`
 * for a plausible address, whether or not it was already listed. The admin routes list, export, invite
 * and remove.
 */
export const waitlistController: (deps: WaitlistControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerWaitlistRoutes(app: FastifyInstance) {
    const audit = deps.auditLogService;

    app.post('/waitlist', { bodyLimit: 2048 }, async (request, reply) => {
      const parsed = JoinSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_email', message: BAD_EMAIL });
      // The visitor's own limit first; only a request inside it counts toward everyone's, so one
      // visitor cannot use up the hour for the rest.
      const tooMany = () => reply.code(429).send({ error: 'rate_limited', message: TOO_MANY });
      if (!(await deps.limiter.hit('waitlist', request.ip, LIMITS.visitor))) return tooMany();
      if (!(await deps.limiter.hit('waitlist-all', 'all', LIMITS.everyone))) return tooMany();
      // A filled-in trap field is a script. Say yes and store nothing, so it learns nothing.
      if (typeof parsed.data.leave_blank === 'string' && parsed.data.leave_blank.trim() !== '') return reply.send({ ok: true });
      const result = await deps.service.join(parsed.data.email);
      if (result === 'invalid') return reply.code(400).send({ error: 'invalid_email', message: BAD_EMAIL });
      return reply.send({ ok: true });
    });

    const findUser = deps.findUser;
    if (!findUser) return;

    const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<UserSummary | undefined> => {
      const admin = await adminCaller(request, findUser);
      if (!admin) {
        await audit?.record({ actorUserId: request.userId ?? null, actorType: 'user', action: 'admin.denied', outcome: 'failure', detail: `${request.method} ${request.url.split('?')[0]}` });
        await reply.code(403).send({ error: 'forbidden', message: 'This needs an admin account.' });
        return undefined;
      }
      return admin;
    };
    const record = (admin: UserSummary, action: string, detail: string) => audit?.record({ actorUserId: admin.id, actorType: 'admin', action, outcome: 'success', detail });

    app.get('/admin/waitlist', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const parsed = ListQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'status must be all, waiting or invited.' });
      const status = parsed.data.status === 'all' ? undefined : (parsed.data.status.toUpperCase() as WaitlistStatus);
      const [rows, counts] = await Promise.all([deps.service.list(status ? { status } : {}), deps.service.counts()]);
      // Reading everyone's email is itself recorded, once per admin per 10 minutes.
      if (audit && (await deps.limiter.hit('admin-view:admin.view_waitlist', admin.id, { limit: 1, windowSeconds: VIEW_LOG_SECONDS }))) await record(admin, 'admin.view_waitlist', `${rows.length} entries`);
      return reply.send({ counts, entries: rows.map(wire), inviteEmail: !!deps.invites });
    });

    app.get('/admin/waitlist/export', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const rows = await deps.service.list({ limit: 100_000 });
      await record(admin, 'waitlist.export', `${rows.length} entries`);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="stryx-waitlist.csv"')
        .header('cache-control', 'no-store')
        .send(waitlistCsv(rows));
    });

    app.post<{ Params: { id: string } }>('/admin/waitlist/:id/invited', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const parsed = InvitedBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Send { "invited": true } or { "invited": false }.' });
      const row = await deps.service.setInvited(request.params.id, parsed.data.invited);
      if (!row) return reply.code(404).send({ error: 'not_found', message: 'That person is no longer on the list.' });
      await record(admin, parsed.data.invited ? 'waitlist.invite' : 'waitlist.uninvite', `entry ${row.id}`);
      return reply.send({ entry: wire(row) });
    });

    app.post<{ Params: { id: string } }>('/admin/waitlist/:id/send-invite', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const invites = deps.invites;
      if (!invites) return reply.code(503).send({ error: 'email_not_configured', message: 'Sending invites by email is not set up on this server (RESEND_API_KEY).' });
      // Claimed first: marking them invited is the lock, so a second click finds nobody waiting.
      const row = await deps.service.claimForInvite(request.params.id);
      if (!row) return reply.code(409).send({ error: 'not_waiting', message: 'This person is no longer waiting: already invited, or removed.' });

      let code: { code: string; id: string; expiresAt: Date } | undefined;
      try {
        code = await invites.createCode({ label: `Waitlist: ${row.email}`.slice(0, 80), createdById: admin.id, expiresInDays: INVITE_CODE_DAYS });
        const email = inviteEmail({ code: code.code, expiresAt: code.expiresAt, appUrl: invites.appUrl, siteUrl: invites.siteUrl, xUrl: invites.xUrl });
        await invites.mailer.send({ to: row.email, ...email, idempotencyKey: `waitlist-invite-${code.id}` });
      } catch (err) {
        // Nothing half-done: the code is taken back and the person is waiting again.
        if (code) await invites.revokeCode(code.id).catch(() => undefined);
        await deps.service.setInvited(row.id, false).catch(() => undefined);
        const reason = err instanceof Error ? err.message : 'unknown error';
        await audit?.record({ actorUserId: admin.id, actorType: 'admin', action: 'waitlist.send_invite', outcome: 'failure', detail: `entry ${row.id}: ${reason.slice(0, 200)}` });
        return reply.code(502).send({ error: 'email_failed', message: `The invite email could not be sent, so nobody was marked invited. ${reason}` });
      }
      await record(admin, 'waitlist.send_invite', `entry ${row.id}, code ${code.id}`);
      return reply.send({ entry: wire(row), expiresAt: code.expiresAt });
    });

    app.delete<{ Params: { id: string } }>('/admin/waitlist/:id', async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const removed = await deps.service.remove(request.params.id);
      if (!removed) return reply.code(404).send({ error: 'not_found', message: 'That person is no longer on the list.' });
      // The id only: the address itself must not outlive the removal in the log.
      await record(admin, 'waitlist.delete', `entry ${request.params.id}`);
      return reply.send({ ok: true });
    });
  };
