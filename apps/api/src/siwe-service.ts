import { createHash } from 'node:crypto';
import { getAddress, isAddress, recoverMessageAddress, type Hex } from 'viem';
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { isSupportedChainId } from './siwe-chains.js';

/** Sign-In With Ethereum (EIP-4361), ADR-003 §4.1. */
export type SiwePurpose = 'sign-in' | 'confirm';

export interface SiweRedisClient {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

interface StoredChallenge {
  address: string;
  chainId: number;
  purpose: SiwePurpose;
  /** Only for `confirm`: the account that asked. */
  userId: string | null;
  message: string;
}

export interface VerifiedSiwe {
  address: `0x${string}`;
  chainId: number;
  purpose: SiwePurpose;
  userId: string | null;
}

export class SiweError extends Error {
  constructor(
    readonly code: 'bad_address' | 'bad_chain' | 'challenge_unknown' | 'challenge_expired' | 'signature_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'SiweError';
  }
}

const STATEMENT: Record<SiwePurpose, string> = {
  'sign-in': 'Sign in to Stryx. This does not send a transaction or cost gas.',
  confirm: 'Confirm a sensitive action on Stryx. This does not send a transaction or cost gas.',
};

export class SiweService {
  /** The dashboard origins (APP_ORIGIN): the main one first. */
  private readonly origins: URL[];

  constructor(
    private readonly redis: SiweRedisClient,
    appOrigin: string | readonly string[],
    private readonly ttlSeconds = 300,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.origins = (typeof appOrigin === 'string' ? [appOrigin] : [...appOrigin]).map((o) => new URL(o));
  }

  /**
   * The origin the message names: the one the request came from when APP_ORIGIN lists it (so a wallet
   * sees the site it is actually on), otherwise the main one.
   */
  private originFor(requestOrigin: string | undefined): URL {
    return this.origins.find((o) => o.origin === requestOrigin) ?? this.origins[0]!;
  }

  /** Writes the message for this address to sign. Mixed-case input must carry a valid checksum. */
  async challenge(input: { address: string; chainId: number; purpose: SiwePurpose; userId?: string | null; origin?: string }): Promise<{ message: string }> {
    if (!isAddress(input.address, { strict: true })) throw new SiweError('bad_address', 'That is not a valid wallet address.');
    if (!isSupportedChainId(input.chainId)) throw new SiweError('bad_chain', 'Switch your wallet to a supported network, then try again.');
    const address = getAddress(input.address);
    const issuedAt = this.now();
    const nonce = generateSiweNonce();
    const origin = this.originFor(input.origin);
    const message = createSiweMessage({
      domain: origin.host, // host and port, exactly as EIP-4361 wants it
      uri: origin.origin,
      address,
      chainId: input.chainId,
      version: '1',
      nonce,
      statement: STATEMENT[input.purpose],
      issuedAt,
      expirationTime: new Date(issuedAt.getTime() + this.ttlSeconds * 1000),
    });
    const stored: StoredChallenge = { address, chainId: input.chainId, purpose: input.purpose, userId: input.userId ?? null, message };
    await this.redis.set(this.key(nonce), JSON.stringify(stored), 'EX', this.ttlSeconds);
    return { message };
  }

  /** Checks a signed message against the challenge it came from. */
  async verify(input: { message: string; signature: string }): Promise<VerifiedSiwe> {
    const nonce = parseSiweMessage(input.message).nonce;
    if (!nonce) throw new SiweError('challenge_unknown', 'That sign-in request is not valid. Start again.');
    const raw = await this.redis.getdel(this.key(nonce));
    if (!raw) throw new SiweError('challenge_unknown', 'That sign-in request expired or was already used. Start again.');
    const stored = JSON.parse(raw) as StoredChallenge;
    if (stored.message !== input.message) throw new SiweError('challenge_unknown', 'That sign-in request is not valid. Start again.');
    const expires = parseSiweMessage(stored.message).expirationTime;
    if (!expires || expires.getTime() <= this.now().getTime()) throw new SiweError('challenge_expired', 'That sign-in request expired. Start again.');

    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message: input.message, signature: input.signature as Hex });
    } catch {
      throw new SiweError('signature_invalid', 'The signature did not match. Try again.');
    }
    if (getAddress(recovered) !== stored.address) {
      throw new SiweError('signature_invalid', 'The signature did not match. Smart contract wallets are not supported yet.');
    }
    return { address: stored.address as `0x${string}`, chainId: stored.chainId, purpose: stored.purpose, userId: stored.userId };
  }

  private key(nonce: string): string {
    return `siwe:nonce:${createHash('sha256').update(nonce).digest('hex')}`;
  }
}
