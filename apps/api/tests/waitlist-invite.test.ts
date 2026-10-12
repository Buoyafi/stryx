import { describe, expect, it } from 'vitest';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { UserAccountService } from '@stryx/user-service';
import { noopLogger } from '@stryx/logger';
import { InProcessEventBus } from '@stryx/event-bus';
import { buildApp } from '../src/app.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { RedisRateLimiter } from '../src/rate-limiter.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { WaitlistService } from '../src/waitlist.js';
import { AccessCodeService } from '../src/access-code-service.js';
import { SiweService } from '../src/siwe-service.js';
import { SessionCookie } from '../src/session-cookie.js';
import { RedisSessionStore } from '../src/session-store.js';
import { claimUrl, inviteEmail, landingUrl, ResendMailer, type Mailer, type OutgoingEmail } from '../src/invite-email.js';
import { normaliseAccessCode } from '../src/access-code.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';
import { InMemoryWaitlistRepository } from './fakes/in-memory-waitlist-repository.js';
import { InMemoryIdentityRepository } from './fakes/in-memory-identity-repository.js';

const OPERATOR = { authorization: 'Bearer test-operator-token' };
const ORIGIN = 'https://app.stryx.test';

class FakeMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  failWith: Error | null = null;
  async send(email: OutgoingEmail) {
    if (this.failWith) throw this.failWith;
    this.sent.push(email);
  }
}

function build(opts: { mail?: boolean } = {}) {
  const kms = new LocalKeyManagementProvider();
  const users = new InMemoryUserRepository();
  const now = new Date();
  users.seed({ id: RESERVED_OPERATOR_USER_ID, email: 'operator@stryx.local', passwordHash: 'disabled', role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: false, createdAt: now, updatedAt: now });
  const redis = new InMemoryRedisClient();
  const identity = new InMemoryIdentityRepository(users);
  const audit = new InMemoryAuditLogRepository();
  const repo = new InMemoryWaitlistRepository();
  const mailer = new FakeMailer();
  const codes = new AccessCodeService(identity, redis, 'x'.repeat(40));
  const app = buildApp({
    walletService: new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId),
    logger: noopLogger,
    authToken: 'test-operator-token',
    operatorTokenMode: 'admin',
    userAccountService: new UserAccountService(users),
    sessions: new RedisSessionStore(redis),
    auditLogService: new AuditLogService(audit, new InProcessEventBus(), noopLogger),
    walletSignIn: { appOrigin: ORIGIN, siwe: new SiweService(redis, ORIGIN), codes, identity, sessionCookie: new SessionCookie(ORIGIN), limiter: new RedisRateLimiter(redis) },
    waitlist: { service: new WaitlistService(repo), limiter: new RedisRateLimiter(redis) },
    ...(opts.mail === false ? {} : { inviteEmail: { mailer, siteUrl: 'https://stryx.test', xUrl: 'https://x.com/stryxapp' } }),
  });
  return { app, repo, mailer, identity, audit, codes };
}

async function joined(repo: InMemoryWaitlistRepository, email = 'ada@example.com') {
  await repo.addIfNew(email, email.toLowerCase());
  return repo.rows.find((r) => r.email === email)!;
}

const send = (app: ReturnType<typeof build>['app'], id: string, headers: Record<string, string> = OPERATOR) => app.inject({ method: 'POST', url: `/admin/waitlist/${id}/send-invite`, headers });

describe('POST /admin/waitlist/:id/send-invite', () => {
  it('makes a 14-day code, emails it to the person, and marks them invited', async () => {
    const { app, repo, mailer, identity, codes } = build();
    const row = await joined(repo);
    const res = await send(app, row.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().entry).toMatchObject({ id: row.id, status: 'invited' });
    expect(repo.rows[0]!.status).toBe('INVITED');

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe('ada@example.com');
    expect(mail.subject).toBe("You're in: your Stryx invite");
    const code = /STRYX-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(mail.text)![0];
    expect(mail.html).toContain(code);
    expect(mail.html).toContain(claimUrl(ORIGIN, code).replace(/&/g, '&amp;'));

    // The emailed code is real, works once, and is labelled with the address for the Invite codes tab.
    const stored = [...identity.codes.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.label).toBe('Waitlist: ada@example.com');
    const days = (stored[0]!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    expect(mail.idempotencyKey).toBe(`waitlist-invite-${stored[0]!.id}`);
    expect(normaliseAccessCode(code)).not.toBeNull();
    expect(await codes.check(code)).toMatchObject({ codeId: stored[0]!.id });
  });

  it('sends once: a second click finds nobody waiting', async () => {
    const { app, repo, mailer } = build();
    const row = await joined(repo);
    const [a, b] = await Promise.all([send(app, row.id), send(app, row.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(mailer.sent).toHaveLength(1);
    expect((await send(app, row.id)).json().error).toBe('not_waiting');
  });

  it('when the email fails, takes the code back and leaves the person waiting', async () => {
    const { app, repo, mailer, identity, audit } = build();
    const row = await joined(repo);
    mailer.failWith = new Error('The mail service refused the email (domain not verified).');
    const res = await send(app, row.id);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'email_failed' });
    expect(res.json().message).toContain('nobody was marked invited');
    expect(res.json().message).toContain('domain not verified');
    expect(repo.rows[0]!.status).toBe('WAITING');
    expect([...identity.codes.values()].every((c) => c.revokedAt)).toBe(true);
    expect(audit.entries.some((e) => e.action === 'waitlist.send_invite' && e.outcome === 'failure')).toBe(true);

    // ...and it can simply be tried again.
    mailer.failWith = null;
    expect((await send(app, row.id)).statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(1);
  });

  it('keeps the address out of the audit log', async () => {
    const { app, repo, audit } = build();
    const row = await joined(repo);
    await send(app, row.id);
    const entry = audit.entries.find((e) => e.action === 'waitlist.send_invite')!;
    expect(entry.outcome).toBe('success');
    expect(JSON.stringify(audit.entries)).not.toContain('ada@example.com');
  });

  it('is admin only, 404s nobody, and says so plainly when email is not set up', async () => {
    const { app, repo, mailer } = build();
    const row = await joined(repo);
    expect((await send(app, row.id, {})).statusCode).toBe(401);
    expect((await send(app, 'missing')).statusCode).toBe(409);
    expect(mailer.sent).toHaveLength(0);

    const off = build({ mail: false });
    const r2 = await joined(off.repo);
    const res = await send(off.app, r2.id);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('email_not_configured');
    expect(off.repo.rows[0]!.status).toBe('WAITING');
  });

  it('tells the dashboard whether email sending is on', async () => {
    expect((await build().app.inject({ method: 'GET', url: '/admin/waitlist', headers: OPERATOR })).json().inviteEmail).toBe(true);
    expect((await build({ mail: false }).app.inject({ method: 'GET', url: '/admin/waitlist', headers: OPERATOR })).json().inviteEmail).toBe(false);
  });
});

describe('the invite email', () => {
  const input = { code: 'STRYX-7KQ4-M2XD', expiresAt: new Date('2026-10-23T09:00:00Z'), appUrl: 'https://app.gostryx.com/', siteUrl: 'https://gostryx.com', xUrl: 'https://x.com/stryxapp' };

  it('carries the code, the expiry day, the claim link, the logo images and the X link', () => {
    const { html, text } = inviteEmail(input);
    for (const part of [html, text]) {
      expect(part).toContain('STRYX-7KQ4-M2XD');
      expect(part).toContain('23 October 2026');
      expect(part).toContain('https://x.com/stryxapp');
    }
    expect(html).toContain('href="https://app.gostryx.com/home?code=STRYX-7KQ4-M2XD"');
    expect(html).toContain('src="https://app.gostryx.com/brand/email-lockup.png"');
    expect(html).toContain('src="https://app.gostryx.com/brand/email-mark.png"');
    expect(html).toContain('src="https://app.gostryx.com/brand/email-x.png"');
    expect(html).not.toMatch(/<svg|<script/i);
    expect(text).toContain('seed phrase');
  });

  it('escapes what goes into the HTML', () => {
    const { html } = inviteEmail({ ...input, code: '<b>"x"</b>' });
    expect(html).not.toContain('<b>"x"</b>');
    expect(html).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  });

  it('finds the landing page from the dashboard address unless SITE_URL says otherwise', () => {
    expect(landingUrl(undefined, 'https://app.gostryx.com')).toBe('https://gostryx.com');
    expect(landingUrl('https://stryx.io/x', 'https://app.gostryx.com')).toBe('https://stryx.io');
    expect(landingUrl(undefined, 'https://dash.example.com')).toBe('https://dash.example.com');
  });
});

describe('ResendMailer', () => {
  const email: OutgoingEmail = { to: 'a@b.io', subject: 'S', html: '<p>h</p>', text: 't', idempotencyKey: 'k-1' };

  it('posts one email with the key, the sender, the reply-to and the idempotency key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response('{"id":"e1"}', { status: 200 }))) as unknown as typeof fetch;
    await new ResendMailer('re_secret', 'Stryx <invites@gostryx.com>', 'hello@gostryx.com', fake).send(email);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_secret');
    expect(headers['idempotency-key']).toBe('k-1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: 'Stryx <invites@gostryx.com>', to: ['a@b.io'], subject: 'S', html: '<p>h</p>', text: 't', reply_to: 'hello@gostryx.com' });
  });

  it("turns a refusal into an error with Resend's reason, and never the key", async () => {
    const fake = (async () => new Response('{"message":"The gostryx.com domain is not verified."}', { status: 403 })) as unknown as typeof fetch;
    const err = await new ResendMailer('re_secret', 'Stryx <invites@gostryx.com>', null, fake).send(email).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('domain is not verified');
    expect((err as Error).message).not.toContain('re_secret');
  });
});
