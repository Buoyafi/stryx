import { createHmac, randomInt } from 'node:crypto';

/**
 * Invite codes: `STRYX-XXXX-XXXX`, 8 characters from a 31-character alphabet without look-alikes (no
 * 0/O, 1/I/L). About 39.6 bits.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const BODY_LENGTH = 8;

export function generateAccessCode(): string {
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i++) body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return formatAccessCode(body);
}

export function formatAccessCode(body: string): string {
  return `STRYX-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

/** What a person typed or pasted, reduced to the 8-character body: case, spaces, dashes and the STRYX prefix do not matter. */
export function normaliseAccessCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s\-_]/g, '');
  const body = compact.startsWith('STRYX') ? compact.slice(5) : compact;
  if (body.length !== BODY_LENGTH) return null;
  for (const ch of body) if (!CODE_ALPHABET.includes(ch)) return null;
  return body;
}

export function hashAccessCode(body: string, secret: string): string {
  return createHmac('sha256', secret).update(`stryx-access-code:${body}`).digest('hex');
}
