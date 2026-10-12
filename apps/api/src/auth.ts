import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { UserId } from '@stryx/wallet-service';
import type { RedisSessionStore } from './session-store.js';
import type { SessionCookie } from './session-cookie.js';

/**
 * Auth gate for the whole app. A request passes with the shared operator token (API_AUTH_TOKEN), which
 * resolves to the reserved operator user (ADR-002 §3.11), or with a session token, which resolves to
 * that session's user. Either way `request.userId` is set before any route runs.
 */

// Paths reachable without a token. Keep this list tiny.
const PUBLIC_PATHS = new Set<string>(['/health', '/auth/signup', '/auth/login', '/waitlist']);

/**
 * Reachable without an account once wallet sign-in is on: the invite-code check, the sign-in challenge
 * and verify, and the Home page's drops feed.
 */
export const WALLET_SIGN_IN_PUBLIC_PATHS: readonly string[] = ['/auth/options', '/auth/code/check', '/auth/siwe/challenge', '/auth/siwe/verify', '/home/drops'];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on unequal lengths; compare something anyway, so length is not an oracle.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * What the operator API token may do (ADR-003 §4.10): `admin` everything, `api` act as the operator
 * but never as an admin, `off` not accepted.
 */
export type OperatorTokenMode = 'admin' | 'api' | 'off';

export interface RegisterAuthOptions {
  expectedToken: string;
  /** Defaults to 'admin', the behaviour before modes existed. */
  tokenMode?: OperatorTokenMode;
  /** The reserved operator user id the legacy bearer token resolves to (ADR-002 §3.11). */
  operatorUserId: UserId;
  /** Optional so tests can use the token-only path without Redis. */
  sessions?: RedisSessionStore;
  /** Wallet sign-in (ADR-003 §4.2). */
  sessionCookie?: SessionCookie;
  /** The dashboard origin, or several (APP_ORIGIN may list more than one; every one is trusted). */
  appOrigin?: string | readonly string[];
}

function sameOrigin(request: FastifyRequest, appOrigins: readonly string[]): boolean {
  const origin = request.headers['origin'];
  if (typeof origin === 'string') return appOrigins.includes(origin);
  return request.headers['sec-fetch-site'] === 'same-origin';
}

export function registerAuth(app: FastifyInstance, options: RegisterAuthOptions): void {
  const walletSignIn = options.sessionCookie && options.appOrigin && options.sessions ? { cookie: options.sessionCookie, origin: typeof options.appOrigin === 'string' ? [options.appOrigin] : options.appOrigin, sessions: options.sessions } : null;
  const publicPaths = new Set<string>([...PUBLIC_PATHS, ...(walletSignIn ? WALLET_SIGN_IN_PUBLIC_PATHS : [])]);
  const badOrigin = (reply: FastifyReply) => reply.code(403).send({ error: 'bad_origin', message: 'This request did not come from the Stryx app.' });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (publicPaths.has(path)) {
      // Signing in is a write too: another site must not be able to sign a visitor in to an account of
      // its choosing (ADR-003 §4.1).
      if (walletSignIn && !SAFE_METHODS.has(request.method) && WALLET_SIGN_IN_PUBLIC_PATHS.includes(path) && !sameOrigin(request, walletSignIn.origin)) {
        return badOrigin(reply);
      }
      return; // public path, no token required
    }

    const header = request.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const provided = header.slice('Bearer '.length);

      const tokenMode = options.tokenMode ?? 'admin';
      if (tokenMode !== 'off' && tokensMatch(provided, options.expectedToken)) {
        request.userId = options.operatorUserId;
        if (tokenMode === 'api') request.adminDenied = true;
        return; // authorized as the operator: fall through to the route handler
      }

      if (options.sessions) {
        const session = await options.sessions.resolve(provided);
        if (session) {
          request.userId = session.userId as UserId;
          request.sessionToken = provided;
          return; // authorized as a real user: fall through
        }
      }

      return reply.code(401).send({ error: 'unauthorized', message: 'Invalid API token.' });
    }

    if (walletSignIn) {
      const token = walletSignIn.cookie.read(request.headers['cookie']);
      if (token) {
        const session = await walletSignIn.sessions.resolve(token);
        if (session) {
          if (!SAFE_METHODS.has(request.method) && !sameOrigin(request, walletSignIn.origin)) return badOrigin(reply);
          request.userId = session.userId as UserId;
          request.sessionToken = token;
          return;
        }
        return reply.code(401).send({ error: 'unauthorized', message: 'Your session ended. Sign in again.' });
      }
    }

    return reply.code(401).send({ error: 'unauthorized', message: 'Missing or malformed Authorization header.' });
  });
}
