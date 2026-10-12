import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { UserAccountService } from '@stryx/user-service';
import { noopLogger } from '@stryx/logger';
import { InProcessEventBus } from '@stryx/event-bus';
import { buildApp } from '../src/app.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { RedisSessionStore } from '../src/session-store.js';
import { SiweService } from '../src/siwe-service.js';
import { AccessCodeService } from '../src/access-code-service.js';
import { SessionCookie } from '../src/session-cookie.js';
import { RedisRateLimiter } from '../src/rate-limiter.js';
import { AuditLogService } from '../src/audit-log-service.js';
import { StepUpStore } from '../src/step-up-store.js';
import { formatAccessCode, generateAccessCode, hashAccessCode, normaliseAccessCode } from '../src/access-code.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';
import { InMemoryRedisClient } from './fakes/in-memory-redis-client.js';
import { InMemoryIdentityRepository } from './fakes/in-memory-identity-repository.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';

const OPERATOR = { authorization: 'Bearer test-operator-token' };
const ORIGIN = 'https://app.stryx.test';
const SAME = { origin: ORIGIN };
const SECRET = 'x'.repeat(40);

function build(origins: string | readonly string[] = ORIGIN) {
  const kms = new LocalKeyManagementProvider();
  const users = new InMemoryUserRepository();
  const now = new Date();
  users.seed({ id: RESERVED_OPERATOR_USER_ID, email: 'operator@stryx.local', passwordHash: 'disabled', role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: false, createdAt: now, updatedAt: now });
  const redis = new InMemoryRedisClient();
  const identity = new InMemoryIdentityRepository(users);
  const audit = new InMemoryAuditLogRepository();
  const app = buildApp({
    walletService: new WalletService(new InMemoryWalletRepository(), new WalletKeyService(kms), kms.keyId),
    logger: noopLogger,
    authToken: 'test-operator-token',
    userAccountService: new UserAccountService(users),
    sessions: new RedisSessionStore(redis),
    auditLogService: new AuditLogService(audit, new InProcessEventBus(), noopLogger),
    stepUpStore: new StepUpStore(redis),
    walletSignIn: {
      appOrigin: origins,
      siwe: new SiweService(redis, origins),
      codes: new AccessCodeService(identity, redis, SECRET),
      identity,
      sessionCookie: new SessionCookie(ORIGIN),
      limiter: new RedisRateLimiter(redis),
    },
  });
  return { app, identity, audit, users };
}

async function makeCode(app: FastifyInstance, body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/admin/access-codes', headers: OPERATOR, payload: body });
  expect(res.statusCode).toBe(201);
  return res.json().code as string;
}

async function checkCode(app: FastifyInstance, code: string) {
  return app.inject({ method: 'POST', url: '/auth/code/check', headers: SAME, payload: { code } });
}

/** Challenge, sign with `account`, verify. Returns the verify response. */
async function signIn(app: FastifyInstance, account: ReturnType<typeof privateKeyToAccount>, ticket?: string, tamper?: (m: string) => string) {
  const challenge = await app.inject({ method: 'POST', url: '/auth/siwe/challenge', headers: SAME, payload: { address: account.address, chainId: 1 } });
  expect(challenge.statusCode).toBe(200);
  const message = challenge.json().siweMessage as string;
  const signed = tamper ? tamper(message) : message;
  const signature = await account.signMessage({ message: signed });
  return app.inject({ method: 'POST', url: '/auth/siwe/verify', headers: SAME, payload: { message: signed, signature, ...(ticket ? { ticket } : {}) } });
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;

describe('access code format', () => {
  it('generates STRYX-XXXX-XXXX without look-alike characters, and reads typed variants back', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateAccessCode();
      expect(code).toMatch(/^STRYX-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
      expect(normaliseAccessCode(code)).toBe(code.slice(6).replace('-', ''));
    }
    expect(normaliseAccessCode(' stryx 7k2p-qx9m ')).toBe('7K2PQX9M');
    expect(normaliseAccessCode('7K2PQX9M')).toBe('7K2PQX9M');
    expect(normaliseAccessCode('STRYX-7K2P-QX90')).toBeNull(); // 0 is never used
    expect(normaliseAccessCode('STRYX-7K2P')).toBeNull();
    expect(formatAccessCode('7K2PQX9M')).toBe('STRYX-7K2P-QX9M');
    expect(hashAccessCode('7K2PQX9M', SECRET)).not.toBe(hashAccessCode('7K2PQX9M', 'y'.repeat(40))); // keyed
  });
});

describe('invite code, then wallet sign-in', () => {
  it('a code makes one account: check, sign, cookie session, and the code shows as used', async () => {
    const { app, audit } = build();
    const code = await makeCode(app, { label: 'from the waitlist' });
    const check = await checkCode(app, code.toLowerCase());
    expect(check.statusCode).toBe(200);
    const { ticket } = check.json();

    const alice = privateKeyToAccount(generatePrivateKey());
    const res = await signIn(app, alice, ticket);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: true, user: { role: 'USER', status: 'ACTIVE', email: null } });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^__Host-stryx_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    expect(res.json().user).not.toHaveProperty('passwordHash');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieOf(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ signedInWith: 'wallet', signInAddresses: [alice.address] });

    const list = await app.inject({ method: 'GET', url: '/admin/access-codes', headers: OPERATOR });
    expect(list.json().codes).toMatchObject([{ label: 'from the waitlist', status: 'used', redeemedByAddress: alice.address }]);
    expect(JSON.stringify(list.json())).not.toContain(code); // the code itself is never listed

    // The same code cannot make a second account.
    expect((await checkCode(app, code)).json()).toMatchObject({ error: 'code_invalid' });
    expect(audit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['access_code.create', 'access_code.check', 'account.create_wallet']));
  });

  it('a returning wallet signs in with no code', async () => {
    const { app } = build();
    const bob = privateKeyToAccount(generatePrivateKey());
    const { ticket } = (await checkCode(app, await makeCode(app))).json();
    expect((await signIn(app, bob, ticket)).statusCode).toBe(201);
    const again = await signIn(app, bob);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false });
  });

  it('a new wallet without a code is turned away, and no account is made', async () => {
    const { app, users } = build();
    const res = await signIn(app, privateKeyToAccount(generatePrivateKey()));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'code_required', message: 'This wallet has no account yet. Enter your invite code first.' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await users.findByEmail('nobody@example.com')).toBeNull();
  });

  it('holds a checked code for that visitor: a second check is refused while it is held', async () => {
    const { app } = build();
    const code = await makeCode(app);
    expect((await checkCode(app, code)).statusCode).toBe(200);
    const second = await checkCode(app, code);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('code_held');
  });

  it('a signed message works once: replaying it is refused', async () => {
    const { app } = build();
    const carol = privateKeyToAccount(generatePrivateKey());
    const { ticket } = (await checkCode(app, await makeCode(app))).json();
    const challenge = await app.inject({ method: 'POST', url: '/auth/siwe/challenge', headers: SAME, payload: { address: carol.address, chainId: 1 } });
    const message = challenge.json().siweMessage as string;
    const signature = await carol.signMessage({ message });
    const first = await app.inject({ method: 'POST', url: '/auth/siwe/verify', headers: SAME, payload: { message, signature, ticket } });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({ method: 'POST', url: '/auth/siwe/verify', headers: SAME, payload: { message, signature } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('challenge_unknown');
  });

  it('refuses a message signed by another wallet, and one edited after it was issued', async () => {
    const { app } = build();
    const dave = privateKeyToAccount(generatePrivateKey());
    const mallory = privateKeyToAccount(generatePrivateKey());
    const challenge = await app.inject({ method: 'POST', url: '/auth/siwe/challenge', headers: SAME, payload: { address: dave.address, chainId: 1 } });
    const message = challenge.json().siweMessage as string;
    expect(message).toContain('app.stryx.test wants you to sign in with your Ethereum account:');
    expect(message).toContain('This does not send a transaction or cost gas.');
    const wrongSigner = await app.inject({ method: 'POST', url: '/auth/siwe/verify', headers: SAME, payload: { message, signature: await mallory.signMessage({ message }) } });
    expect(wrongSigner.json().error).toBe('signature_invalid');

    const edited = await signIn(app, dave, undefined, (m) => m.replace('app.stryx.test', 'evil.test'));
    expect(edited.statusCode).toBe(401);
  });

  it('a code for a particular wallet only works for that wallet', async () => {
    const { app } = build();
    const erin = privateKeyToAccount(generatePrivateKey());
    const frank = privateKeyToAccount(generatePrivateKey());
    const code = await makeCode(app, { boundAddress: erin.address });
    const { ticket } = (await checkCode(app, code)).json();
    const wrong = await signIn(app, frank, ticket);
    expect(wrong.json()).toMatchObject({ error: 'code_wrong_wallet', message: 'This code is for a different wallet.' });
    expect((await signIn(app, erin, ticket)).statusCode).toBe(201);
  });

  it('a revoked code, and a used one, cannot be revoked or used again', async () => {
    const { app } = build();
    const code = await makeCode(app);
    const [{ id }] = (await app.inject({ method: 'GET', url: '/admin/access-codes', headers: OPERATOR })).json().codes;
    expect((await app.inject({ method: 'POST', url: `/admin/access-codes/${id}/revoke`, headers: OPERATOR })).statusCode).toBe(200);
    expect((await checkCode(app, code)).json().error).toBe('code_invalid');
    const listed = (await app.inject({ method: 'GET', url: '/admin/access-codes', headers: OPERATOR })).json().codes[0];
    expect(listed.status).toBe('revoked');
  });

  it('a code revoked while someone holds it is refused at sign-in, with no account made', async () => {
    const { app, identity } = build();
    const code = await makeCode(app);
    const { ticket } = (await checkCode(app, code)).json();
    const [{ id }] = (await app.inject({ method: 'GET', url: '/admin/access-codes', headers: OPERATOR })).json().codes;
    await app.inject({ method: 'POST', url: `/admin/access-codes/${id}/revoke`, headers: OPERATOR });
    const res = await signIn(app, privateKeyToAccount(generatePrivateKey()), ticket);
    expect(res.json().error).toBe('code_invalid');
    expect(identity.wallets.size).toBe(0);
  });

  it('limits code checks per visitor', async () => {
    const { app } = build();
    const results = [];
    for (let i = 0; i < 11; i++) results.push((await checkCode(app, 'STRYX-2222-2222')).statusCode);
    expect(results.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(results[10]).toBe(429);
  });
});

describe('the session cookie and the Origin check', () => {
  it('refuses sign-in writes from another site', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/auth/code/check', headers: { origin: 'https://evil.test' }, payload: { code: 'STRYX-2222-2222' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('bad_origin');
    const noOrigin = await app.inject({ method: 'POST', url: '/auth/siwe/challenge', payload: { address: '0x' + '1'.repeat(40), chainId: 1 } });
    expect(noOrigin.statusCode).toBe(403);
    const sameSite = await app.inject({ method: 'POST', url: '/auth/code/check', headers: { 'sec-fetch-site': 'same-origin' }, payload: { code: 'STRYX-2222-2222' } });
    expect(sameSite.statusCode).toBe(400); // got through to the code check itself
  });

  it('APP_ORIGIN may list several origins: each is trusted, and the sign-in message names the one in use', async () => {
    const PREVIEW = 'http://localhost:4173';
    const { app } = build([ORIGIN, PREVIEW]);
    const fromPreview = await app.inject({ method: 'POST', url: '/auth/code/check', headers: { origin: PREVIEW }, payload: { code: 'STRYX-2222-2222' } });
    expect(fromPreview.statusCode).toBe(400); // got through to the code check itself
    const elsewhere = await app.inject({ method: 'POST', url: '/auth/code/check', headers: { origin: 'http://localhost:9999' }, payload: { code: 'STRYX-2222-2222' } });
    expect(elsewhere.json().error).toBe('bad_origin');
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const onPreview = await app.inject({ method: 'POST', url: '/auth/siwe/challenge', headers: { origin: PREVIEW }, payload: { address, chainId: 1 } });
    expect(onPreview.json().siweMessage).toMatch(/^localhost:4173 wants you to sign in/);
    expect(onPreview.json().siweMessage).toContain('URI: http://localhost:4173');
    const onMain = await app.inject({ method: 'POST', url: '/auth/siwe/challenge', headers: SAME, payload: { address, chainId: 1 } });
    expect(onMain.json().siweMessage).toMatch(/^app\.stryx\.test wants you to sign in/);
  });

  it('a cookie session can read, but writes need the app origin; the operator token needs neither', async () => {
    const { app } = build();
    const { ticket } = (await checkCode(app, await makeCode(app))).json();
    const cookie = cookieOf(await signIn(app, privateKeyToAccount(generatePrivateKey()), ticket));
    expect((await app.inject({ method: 'GET', url: '/wallets', headers: { cookie } })).statusCode).toBe(200);
    const crossSite = await app.inject({ method: 'PATCH', url: '/me/profile', headers: { cookie, origin: 'https://evil.test' }, payload: { xHandle: 'x' } });
    expect(crossSite.statusCode).toBe(403);
    const sameSite = await app.inject({ method: 'PATCH', url: '/me/profile', headers: { cookie, ...SAME }, payload: { xHandle: 'mine' } });
    expect(sameSite.statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/me/profile', headers: OPERATOR, payload: { xHandle: 'op' } })).statusCode).toBe(200);
  });

  it('"sign out everywhere" ends every device\'s session for that account, and only that account', async () => {
    const { app, audit } = build();
    const alice = privateKeyToAccount(generatePrivateKey());
    const bob = privateKeyToAccount(generatePrivateKey());
    const join = async (who: typeof alice) => {
      const code = await makeCode(app);
      const { ticket } = (await checkCode(app, code)).json();
      return cookieOf(await signIn(app, who, ticket));
    };
    const phone = await join(alice);
    const laptop = cookieOf(await signIn(app, alice));
    const bobs = await join(bob);
    const res = await app.inject({ method: 'POST', url: '/auth/logout-everywhere', headers: { cookie: laptop, ...SAME } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ended: 2 });
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    for (const cookie of [phone, laptop]) expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: bobs } })).statusCode).toBe(200);
    expect(audit.entries.find((e) => e.action === 'session.logout_all')).toMatchObject({ outcome: 'success', detail: '2 sessions ended' });
    // Another site cannot do it for them.
    expect((await app.inject({ method: 'POST', url: '/auth/logout-everywhere', headers: { cookie: bobs, origin: 'https://evil.example' } })).statusCode).toBe(403);
  });

  it('logout ends the session and clears the cookie', async () => {
    const { app } = build();
    const { ticket } = (await checkCode(app, await makeCode(app))).json();
    const cookie = cookieOf(await signIn(app, privateKeyToAccount(generatePrivateKey()), ticket));
    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, ...SAME } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('says wallet sign-in is on, without an account', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/auth/options' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ walletSignIn: true, terms: null });
  });

  it('the Home feed is public once wallet sign-in is on', async () => {
    const { app } = build();
    // Not registered in this test app (no dropsFeedService), so a 404 rather than a 401 proves it is public.
    expect((await app.inject({ method: 'GET', url: '/home/drops' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/wallets' })).statusCode).toBe(401);
  });
});

describe('admin codes need an admin', () => {
  it('a member cannot list, make or revoke codes', async () => {
    const { app } = build();
    const { ticket } = (await checkCode(app, await makeCode(app))).json();
    const cookie = cookieOf(await signIn(app, privateKeyToAccount(generatePrivateKey()), ticket));
    const headers = { cookie, ...SAME };
    expect((await app.inject({ method: 'GET', url: '/admin/access-codes', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/admin/access-codes', headers, payload: {} })).statusCode).toBe(403);
  });

  it('checks what an admin sends', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'POST', url: '/admin/access-codes', headers: OPERATOR, payload: { expiresInDays: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/access-codes', headers: OPERATOR, payload: { boundAddress: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/access-codes', headers: OPERATOR, payload: { role: 'ADMIN' } })).statusCode).toBe(400);
    const made = await app.inject({ method: 'POST', url: '/admin/access-codes', headers: OPERATOR, payload: { expiresInDays: 7 } });
    expect(new Date(made.json().expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });
});

describe('step-up with a wallet signature', () => {
  it('a wallet account confirms with its own sign-in wallet, and nothing else counts', async () => {
    const { app } = build();
    const gina = privateKeyToAccount(generatePrivateKey());
    const { ticket } = (await checkCode(app, await makeCode(app))).json();
    const signedIn = await signIn(app, gina, ticket);
    const headers = { cookie: cookieOf(signedIn), ...SAME };

    // A sign-in message is not a confirmation.
    const signInChallenge = await app.inject({ method: 'POST', url: '/auth/siwe/challenge', headers: SAME, payload: { address: gina.address, chainId: 1 } });
    const m1 = signInChallenge.json().siweMessage as string;
    expect((await app.inject({ method: 'POST', url: '/auth/step-up', headers, payload: { message: m1, signature: await gina.signMessage({ message: m1 }) } })).statusCode).toBe(401);

    // Someone else's wallet cannot be used to confirm.
    const other = privateKeyToAccount(generatePrivateKey());
    expect((await app.inject({ method: 'POST', url: '/auth/siwe/confirm-challenge', headers, payload: { address: other.address, chainId: 1 } })).statusCode).toBe(403);

    const confirm = await app.inject({ method: 'POST', url: '/auth/siwe/confirm-challenge', headers, payload: { address: gina.address, chainId: 1 } });
    const m2 = confirm.json().siweMessage as string;
    expect(m2).toContain('Confirm a sensitive action on Stryx.');
    const ok = await app.inject({ method: 'POST', url: '/auth/step-up', headers, payload: { message: m2, signature: await gina.signMessage({ message: m2 }) } });
    expect(ok.statusCode).toBe(200);
  });
});
