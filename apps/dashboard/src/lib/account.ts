import { ApiError, apiRequest } from './api';
import type { WalletSession } from './wallet';
import type { Me } from './profile';

/** The visitor's side of "invite code first, then wallet sign-in". */

const TICKET_KEY = 'stryx.codeTicket';
const JOINED_KEY = 'stryx.justJoined';

interface HeldTicket {
  ticket: string;
  expiresAt: number;
}

export function heldTicket(now = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(TICKET_KEY);
    if (!raw) return null;
    const held = JSON.parse(raw) as HeldTicket;
    if (held.expiresAt <= now) {
      sessionStorage.removeItem(TICKET_KEY);
      return null;
    }
    return held.ticket;
  } catch {
    return null;
  }
}

export function forgetTicket(): void {
  try {
    sessionStorage.removeItem(TICKET_KEY);
  } catch {
    // storage blocked: nothing was kept
  }
}

/** Is the invite-code front door on for this server? Off (or unreachable) means the token login only. */
export async function walletSignInEnabled(): Promise<boolean> {
  return (await authOptions()).walletSignIn;
}

/** The versions a new account has to accept, or null when the server is not asking (acceptance is off). */
export interface TermsVersions {
  termsVersion: string;
  privacyVersion: string;
}

/** What the server says about signing in: is wallet sign-in on, and which terms must a new account accept. */
export async function authOptions(): Promise<{ walletSignIn: boolean; terms: TermsVersions | null }> {
  try {
    const res = await apiRequest<{ walletSignIn?: boolean; terms?: TermsVersions | null }>('/auth/options');
    return { walletSignIn: res.walletSignIn === true, terms: res.terms ?? null };
  } catch {
    return { walletSignIn: false, terms: null };
  }
}

/** The account behind the session cookie, or null when there is none. */
export async function currentAccount(): Promise<Me | null> {
  try {
    return await apiRequest<Me>('/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** A short, human reason from an API error body, with a fallback. */
export function reasonOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string' && body.message) return body.message;
    if (err.status === 429) return 'Too many tries. Wait a few minutes, then try again.';
  }
  return fallback;
}

export function errorCode(err: unknown): string | null {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown } | null;
    return body && typeof body.error === 'string' ? body.error : null;
  }
  return null;
}

export async function checkCode(code: string): Promise<void> {
  const res = await apiRequest<{ ticket: string; expiresInSeconds: number }>('/auth/code/check', { method: 'POST', body: { code } });
  try {
    sessionStorage.setItem(TICKET_KEY, JSON.stringify({ ticket: res.ticket, expiresAt: Date.now() + res.expiresInSeconds * 1000 } satisfies HeldTicket));
  } catch {
    // storage blocked: the ticket still works for this page view
    memoryTicket = res.ticket;
  }
}
let memoryTicket: string | null = null;

/** Chain the sign-in message names. */
export function messageChainId(walletChainId: number | null, known: (id: number) => boolean): number {
  return walletChainId !== null && known(walletChainId) ? walletChainId : 1;
}

export async function signInWithWallet(input: { session: WalletSession; address: string; chainId: number; acceptedTerms?: TermsVersions | null }): Promise<{ created: boolean }> {
  const { siweMessage } = await apiRequest<{ siweMessage: string }>('/auth/siwe/challenge', { method: 'POST', body: { address: input.address, chainId: input.chainId } });
  const signature = await input.session.signMessage(input.address, siweMessage);
  const ticket = heldTicket() ?? memoryTicket;
  const res = await apiRequest<{ created: boolean }>('/auth/siwe/verify', { method: 'POST', body: { message: siweMessage, signature, ...(ticket ? { ticket } : {}), ...(input.acceptedTerms ? { acceptedTerms: input.acceptedTerms } : {}) } });
  forgetTicket();
  memoryTicket = null;
  if (res.created) markJustJoined();
  return res;
}

/** Step-up for a wallet account: sign a fresh "confirm" message with the wallet it signed in with. */
export async function confirmWithWallet(input: { session: WalletSession; address: string; chainId: number }): Promise<void> {
  const { siweMessage } = await apiRequest<{ siweMessage: string }>('/auth/siwe/confirm-challenge', { method: 'POST', body: { address: input.address, chainId: input.chainId } });
  const signature = await input.session.signMessage(input.address, siweMessage);
  await apiRequest('/auth/step-up', { method: 'POST', body: { message: siweMessage, signature } });
}

/** A brand-new account sees a one-time "You are in" on Home. */
function markJustJoined(): void {
  try {
    sessionStorage.setItem(JOINED_KEY, '1');
  } catch {
    // storage blocked: skip the welcome
  }
}

/** Read-only, so it is safe in a state initializer (React may run those twice). */
export function isJustJoined(): boolean {
  try {
    return sessionStorage.getItem(JOINED_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearJustJoined(): void {
  try {
    sessionStorage.removeItem(JOINED_KEY);
  } catch {
    // storage blocked: nothing to clear
  }
}
