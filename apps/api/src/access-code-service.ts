import { createHash, randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import { generateAccessCode, hashAccessCode, normaliseAccessCode } from './access-code.js';
import { codeUsable, type AccessCodeRecord, type IdentityRepository } from './identity-repository.js';

/**
 * Invite codes: made by an admin, checked by a visitor, used up when that visitor's wallet sign-in
 * creates their account. Checking a code does not use it: it puts a 15-minute hold on it.
 */
export interface AccessCodeRedisClient {
  set(key: string, value: string, mode: 'EX', seconds: number, nx: 'NX'): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export type CheckResult = { ticket: string; codeId: string; expiresInSeconds: number } | 'invalid' | 'held';

export class AccessCodeService {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly redis: AccessCodeRedisClient,
    private readonly secret: string,
    private readonly holdSeconds = 15 * 60,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Makes a new code. The plain code is returned here once and never stored. */
  async create(input: { label: string | null; createdById: string; boundAddress: string | null; expiresInDays: number | null }): Promise<{ code: string; record: AccessCodeRecord }> {
    const expiresAt = input.expiresInDays ? new Date(this.now().getTime() + input.expiresInDays * 86_400_000) : null;
    const boundAddressLower = input.boundAddress ? getAddress(input.boundAddress).toLowerCase() : null;
    // A collision is astronomically unlikely, but the hash is unique, so try again rather than fail.
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateAccessCode();
      const body = normaliseAccessCode(code)!;
      const hash = hashAccessCode(body, this.secret);
      if (await this.repository.findAccessCodeByHash(hash)) continue;
      const record = await this.repository.createAccessCode({ codeHash: hash, label: input.label, createdById: input.createdById, boundAddressLower, expiresAt });
      return { code, record };
    }
    throw new Error('Could not make a unique access code; try again.');
  }

  /** Checks what a visitor typed and, when it is usable, holds it for them. */
  async check(input: string): Promise<CheckResult> {
    const body = normaliseAccessCode(input);
    if (!body) return 'invalid';
    const code = await this.repository.findAccessCodeByHash(hashAccessCode(body, this.secret));
    if (!code || !codeUsable(code, this.now())) return 'invalid';
    const ticket = randomBytes(24).toString('base64url');
    const held = await this.redis.set(this.holdKey(code.id), this.ticketHash(ticket), 'EX', this.holdSeconds, 'NX');
    if (held !== 'OK') return 'held';
    await this.redis.set(this.ticketKey(ticket), code.id, 'EX', this.holdSeconds, 'NX');
    return { ticket, codeId: code.id, expiresInSeconds: this.holdSeconds };
  }

  /** The code a ticket holds, while the hold lasts. */
  async resolveTicket(ticket: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(ticket)) return null;
    return this.redis.get(this.ticketKey(ticket));
  }

  /** Lets go of a hold (after the account was made, or when the code turned out not to fit). */
  async release(ticket: string, codeId: string): Promise<void> {
    await this.redis.del(this.ticketKey(ticket));
    if ((await this.redis.get(this.holdKey(codeId))) === this.ticketHash(ticket)) await this.redis.del(this.holdKey(codeId));
  }

  private ticketHash(ticket: string): string {
    return createHash('sha256').update(ticket).digest('hex');
  }
  private holdKey(codeId: string): string {
    return `access-code:hold:${codeId}`;
  }
  private ticketKey(ticket: string): string {
    return `access-code:ticket:${this.ticketHash(ticket)}`;
  }
}
