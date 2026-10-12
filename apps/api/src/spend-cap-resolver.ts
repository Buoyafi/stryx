import { parseUnits } from 'viem';
import type { UserAccountService } from '@stryx/user-service';
import { chainById } from './chain-registry.js';

/** Used only when neither the user nor DEFAULT_DAILY_SPEND_CAP_WEI sets a cap. */
const HARDCODED_FALLBACK_CAP_WEI = 1_000_000_000_000_000_000n; // 1 ETH/day

/**
 * Resolves a user's daily spending cap on one chain (ADR-002 §3.7): the user's own, else the platform
 * default for that chain, else the built-in fallback. Null means unlimited.
 */
export class SpendCapResolver {
  constructor(
    private readonly userAccountService: UserAccountService,
    private readonly platformDefaultCapWei: bigint | undefined,
    /** Per-chain defaults in wei, from DEFAULT_DAILY_SPEND_CAPS (see parsePerChainCaps). */
    private readonly perChainDefaultsWei: ReadonlyMap<number, bigint> = new Map(),
    /** WALLET_DAILY_SPEND_SHARE_PERCENT: how much of the account's day one wallet may spend. */
    private readonly walletSharePercent = 50,
  ) {}

  /** One wallet's own daily cap on a chain, from the account's cap there (`resolve`): that share of it, rounded down. */
  walletCap(accountCapWei: bigint | null): bigint | null {
    if (accountCapWei === null || this.walletSharePercent >= 100) return null;
    return (accountCapWei * BigInt(this.walletSharePercent)) / 100n;
  }

  async resolve(ownerId: string, chainId: number): Promise<bigint | null> {
    const user = await this.userAccountService.getUserSummary(ownerId);
    if (user && !user.spendCapEnabled) return null;
    if (isEthChain(chainId) && user?.dailySpendCapWei) return BigInt(user.dailySpendCapWei);
    return this.defaultCap(chainId);
  }

  private defaultCap(chainId: number): bigint {
    const perChain = this.perChainDefaultsWei.get(chainId);
    if (perChain !== undefined) return perChain;
    if (isEthChain(chainId)) return this.platformDefaultCapWei ?? HARDCODED_FALLBACK_CAP_WEI;
    return 0n;
  }
}

function isEthChain(chainId: number): boolean {
  return chainById(chainId)?.nativeCurrency.symbol === 'ETH';
}

/**
 * Parses DEFAULT_DAILY_SPEND_CAPS: comma-separated `chainId=amount`, each amount in that chain's own
 * token. Throws on a malformed entry.
 */
export function parsePerChainCaps(raw: string | undefined): Map<number, bigint> {
  const caps = new Map<number, bigint>();
  if (!raw || raw.trim() === '') return caps;
  for (const part of raw.split(',')) {
    const m = /^\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!m) throw new Error(`DEFAULT_DAILY_SPEND_CAPS: "${part.trim()}" is not chainId=amount (e.g. 56=2).`);
    const chainId = Number(m[1]);
    const chain = chainById(chainId);
    if (!chain) throw new Error(`DEFAULT_DAILY_SPEND_CAPS: chain ${chainId} is not a chain Stryx knows.`);
    caps.set(chainId, parseUnits(m[2]!, chain.nativeCurrency.decimals));
  }
  return caps;
}
