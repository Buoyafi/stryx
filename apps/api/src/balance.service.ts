import { formatEther } from 'viem';
import type { ChainServices } from './chain-services.js';
import { chainById } from './chain-registry.js';
import { withTimeout } from '@stryx/utils';

/** A wallet's native balance on one chain. */
export interface ChainBalance {
  chainId: number;
  chainName: string;
  wei: string;
  formatted: string;
  /** Set when this chain's balance couldn't be read (RPC down, etc.): the rest still return. */
  error?: string;
}

/**
 * Reads a wallet's native token balance on every configured chain. One slow or failing chain never
 * blocks or fails the others.
 */
/** Per-chain read budget, so one unresponsive RPC cannot hang the whole read. */
const BALANCE_TIMEOUT_MS = 8_000;

export class BalanceService {
  constructor(private readonly chainServices: Map<number, ChainServices>) {}

  async getBalances(address: `0x${string}`): Promise<ChainBalance[]> {
    const results = await Promise.all([...this.chainServices.keys()].map((chainId) => this.getBalanceOn(address, chainId)));
    return results.sort((a, b) => a.chainId - b.chainId);
  }

  /** One chain only, for lists that show every wallet on one chain: nothing waits on the other chains. */
  async getBalanceOn(address: `0x${string}`, chainId: number): Promise<ChainBalance> {
    const chainName = chainById(chainId)?.name ?? `Chain ${chainId}`;
    const services = this.chainServices.get(chainId);
    if (!services) return { chainId, chainName, wei: '0', formatted: '0', error: `${chainName} has no RPC configured.` };
    try {
      const wei = await withTimeout(services.publicClient.getBalance({ address }), BALANCE_TIMEOUT_MS, `${chainName} balance read`);
      return { chainId, chainName, wei: wei.toString(), formatted: formatEther(wei) };
    } catch (err) {
      return { chainId, chainName, wei: '0', formatted: '0', error: describeBalanceError(err, chainName) };
    }
  }
}

/** A short, URL-free reason for a failed balance read: viem's own message embeds the RPC URL and its key. */
export function describeBalanceError(err: unknown, chainName: string): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout/i.test(text)) return `${chainName} RPC did not answer in time.`;
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|must be authenticated/i.test(text)) return `${chainName} RPC refused the request (check the API key in its URL).`;
  if (/\b429\b|rate limit|too many requests/i.test(text)) return `${chainName} RPC is rate-limiting requests.`;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|socket|network/i.test(text)) return `${chainName} RPC could not be reached.`;
  return `${chainName} balance could not be read.`;
}
