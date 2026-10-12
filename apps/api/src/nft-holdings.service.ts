import { withRetry, isFetchTransportFailure } from '@stryx/utils';
import type { UserId, WalletService } from '@stryx/wallet-service';
import type { FetchLike } from './opensea-resolver.js';
import type { NftLedgerService } from './nft-ledger.service.js';
import type { NftStandard } from './nft-ledger-repository.js';

export interface NftHolding {
  contract: string;
  tokenId: string;
  standard: NftStandard;
  amount: string;
  name?: string;
  imageUrl?: string;
}

/** "What does this wallet hold" for one chain. */
export interface NftHoldingsProvider {
  listHoldings(address: `0x${string}`): Promise<NftHolding[]>;
}

interface AlchemyOwnedNft {
  contract: { address: string };
  tokenId: string;
  tokenType?: string;
  balance?: string;
  name?: string | null;
  image?: { cachedUrl?: string | null; originalUrl?: string | null } | null;
}

/** 50 pages of 100: a wallet holding more than 5,000 tokens is cut off there. */
const MAX_HOLDINGS_PAGES = 50;

/** Alchemy's NFT API v3 `getNFTsForOwner`. */
export class AlchemyNftHoldingsProvider implements NftHoldingsProvider {
  constructor(
    private readonly apiBase: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  async listHoldings(address: `0x${string}`): Promise<NftHolding[]> {
    const owned: AlchemyOwnedNft[] = [];
    let pageKey: string | undefined;
    // Every page, not just the first 100: a token past it could not be seen or moved.
    for (let page = 0; page < MAX_HOLDINGS_PAGES; page++) {
      const body = await this.fetchPage(address, pageKey);
      owned.push(...(body.ownedNfts ?? []));
      pageKey = body.pageKey ?? undefined;
      if (!pageKey) break;
    }
    return owned.map((nft) => ({
      contract: nft.contract.address,
      tokenId: nft.tokenId,
      standard: nft.tokenType === 'ERC1155' ? ('erc1155' as const) : ('erc721' as const),
      amount: nft.tokenType === 'ERC1155' ? (nft.balance ?? '1') : '1',
      ...(nft.name ? { name: nft.name } : {}),
      ...(nft.image?.cachedUrl ?? nft.image?.originalUrl ? { imageUrl: (nft.image!.cachedUrl ?? nft.image!.originalUrl)! } : {}),
    }));
  }

  private async fetchPage(address: `0x${string}`, pageKey?: string): Promise<{ ownedNfts?: AlchemyOwnedNft[]; pageKey?: string | null }> {
    const url = `${this.apiBase}/getNFTsForOwner?owner=${address}&withMetadata=true&pageSize=100${pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : ''}`;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await withRetry(() => this.fetchImpl(url), { attempts: 2, delayMs: 300, isRetryable: isFetchTransportFailure });
    } catch (err) {
      throw new Error(`Alchemy NFT API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`Alchemy NFT API returned HTTP ${res.status}`);
    return (await res.json()) as { ownedNfts?: AlchemyOwnedNft[]; pageKey?: string | null };
  }
}

/** Reads straight from our own mint ledger: only ever knows about tokens Stryx itself minted. */
export class LedgerNftHoldingsProvider implements NftHoldingsProvider {
  constructor(
    private readonly ledger: NftLedgerService,
    private readonly walletId: string,
    private readonly chainId: number,
  ) {}

  async listHoldings(): Promise<NftHolding[]> {
    const records = await this.ledger.listHeld(this.walletId, this.chainId);
    return records.map((r) => ({ contract: r.contract, tokenId: r.tokenId, standard: r.standard, amount: r.amount }));
  }
}

/**
 * Alchemy's NFT API lives on the same host and key as its JSON-RPC, under a different path: derived
 * from the RPC URL so no second setting is needed.
 */
export function deriveAlchemyNftApiBase(rpcUrl: string): string | null {
  try {
    const url = new URL(rpcUrl);
    if (!url.hostname.endsWith('.g.alchemy.com')) return null;
    const key = url.pathname.split('/').filter(Boolean).pop();
    if (!key) return null;
    return `https://${url.hostname}/nft/v3/${key}`;
  } catch {
    return null;
  }
}

export interface HoldingsResult {
  /** Which source answered. 'ledger' means only tokens minted through Stryx, and the dashboard says so. */
  source: 'alchemy' | 'ledger';
  holdings: NftHolding[];
}

/**
 * What a wallet holds: the live indexer first when one is configured for the chain, falling back to
 * Stryx's own mint ledger on any failure.
 */
export class NftHoldingsService {
  constructor(
    private readonly walletService: WalletService,
    private readonly ledger: NftLedgerService,
    /** Chains with a live indexer available, built once from configured RPC URLs. */
    private readonly alchemyProviders: ReadonlyMap<number, AlchemyNftHoldingsProvider>,
  ) {}

  async listHoldings(ownerId: UserId, walletId: string, chainId: number): Promise<HoldingsResult> {
    const wallet = await this.walletService.getWalletSummary(ownerId, walletId);
    const alchemy = this.alchemyProviders.get(chainId);

    if (alchemy) {
      try {
        const holdings = await alchemy.listHoldings(wallet.address as `0x${string}`);
        return { source: 'alchemy', holdings };
      } catch {
        // Falls through to the ledger: a narrower answer instead of a failed request.
      }
    }

    const holdings = await new LedgerNftHoldingsProvider(this.ledger, walletId, chainId).listHoldings();
    return { source: 'ledger', holdings };
  }
}
