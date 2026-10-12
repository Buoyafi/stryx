import { describe, expect, it } from 'vitest';
import type { UserId } from '@stryx/wallet-service';
import { AlchemyNftHoldingsProvider, NftHoldingsService, deriveAlchemyNftApiBase } from '../src/nft-holdings.service.js';
import { NftLedgerService } from '../src/nft-ledger.service.js';
import { InMemoryNftLedgerRepository } from './fakes/in-memory-nft-ledger-repository.js';

const CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890';
const ADDRESS = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const OWNER_ID = 'owner-1' as UserId;

function fakeWalletService() {
  return {
    async getWalletSummary() {
      return { id: 'w1', address: ADDRESS };
    },
  } as never;
}

describe('deriveAlchemyNftApiBase', () => {
  it('derives the NFT API base from an Alchemy RPC URL, same host and key, different path', () => {
    expect(deriveAlchemyNftApiBase('https://robinhood-mainnet.g.alchemy.com/v2/my-real-key')).toBe(
      'https://robinhood-mainnet.g.alchemy.com/nft/v3/my-real-key',
    );
  });

  it('returns null for a non-Alchemy RPC URL', () => {
    expect(deriveAlchemyNftApiBase('https://multi-snowy-frog.robinhood-mainnet.quiknode.pro/abc123/')).toBeNull();
  });

  it('returns null for a malformed URL rather than throwing', () => {
    expect(deriveAlchemyNftApiBase('not a url')).toBeNull();
  });
});

describe('AlchemyNftHoldingsProvider', () => {
  it('maps a real-shaped getNFTsForOwner response into NftHolding rows', async () => {
    const provider = new AlchemyNftHoldingsProvider('https://x.g.alchemy.com/nft/v3/key', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ownedNfts: [
          { contract: { address: CONTRACT }, tokenId: '5', tokenType: 'ERC721', name: 'Cool Cat', image: { cachedUrl: 'https://img/5.png' } },
          { contract: { address: CONTRACT }, tokenId: '9', tokenType: 'ERC1155', balance: '3' },
        ],
      }),
    }));

    const holdings = await provider.listHoldings(ADDRESS);

    expect(holdings).toEqual([
      { contract: CONTRACT, tokenId: '5', standard: 'erc721', amount: '1', name: 'Cool Cat', imageUrl: 'https://img/5.png' },
      { contract: CONTRACT, tokenId: '9', standard: 'erc1155', amount: '3' },
    ]);
  });

  it('throws on a non-2xx response', async () => {
    const provider = new AlchemyNftHoldingsProvider('https://x.g.alchemy.com/nft/v3/key', async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    await expect(provider.listHoldings(ADDRESS)).rejects.toThrow(/500/);
  });

  it('follows pageKey past the first page of 100', async () => {
    const urls: string[] = [];
    const provider = new AlchemyNftHoldingsProvider('https://x.g.alchemy.com/nft/v3/key', async (url) => {
      urls.push(String(url));
      const second = String(url).includes('pageKey=');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ownedNfts: [{ contract: { address: CONTRACT }, tokenId: second ? '101' : '1', tokenType: 'ERC721' }],
          ...(second ? {} : { pageKey: 'next/page' }),
        }),
      };
    });

    const holdings = await provider.listHoldings(ADDRESS);

    expect(holdings.map((h) => h.tokenId)).toEqual(['1', '101']);
    expect(urls[1]).toContain('pageKey=next%2Fpage');
  });
});

describe('NftHoldingsService', () => {
  it('uses the Alchemy provider when one is configured for the chain', async () => {
    const ledger = new NftLedgerService(new InMemoryNftLedgerRepository());
    const alchemy = new AlchemyNftHoldingsProvider('https://x.g.alchemy.com/nft/v3/key', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ownedNfts: [{ contract: { address: CONTRACT }, tokenId: '1', tokenType: 'ERC721' }] }),
    }));
    const service = new NftHoldingsService(fakeWalletService(), ledger, new Map([[CHAIN_ID, alchemy]]));

    const result = await service.listHoldings(OWNER_ID, 'w1', CHAIN_ID);

    expect(result.source).toBe('alchemy');
    expect(result.holdings).toHaveLength(1);
  });

  it('falls back to the ledger, labeled honestly, when no Alchemy provider is configured for the chain', async () => {
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);
    await ledger.recordMint({ walletId: 'w1', ownerId: 'owner-1', chainId: CHAIN_ID, contract: CONTRACT, standard: 'erc721' }, [{ tokenId: '1', amount: '1' }]);
    const service = new NftHoldingsService(fakeWalletService(), ledger, new Map());

    const result = await service.listHoldings(OWNER_ID, 'w1', CHAIN_ID);

    expect(result.source).toBe('ledger');
    expect(result.holdings).toEqual([{ contract: CONTRACT, tokenId: '1', standard: 'erc721', amount: '1' }]);
  });

  it('falls back to the ledger when the configured Alchemy provider fails, without throwing', async () => {
    const repo = new InMemoryNftLedgerRepository();
    const ledger = new NftLedgerService(repo);
    await ledger.recordMint({ walletId: 'w1', ownerId: 'owner-1', chainId: CHAIN_ID, contract: CONTRACT, standard: 'erc721' }, [{ tokenId: '7', amount: '1' }]);
    const brokenAlchemy = new AlchemyNftHoldingsProvider('https://x.g.alchemy.com/nft/v3/key', async () => {
      throw new Error('network down');
    });
    const service = new NftHoldingsService(fakeWalletService(), ledger, new Map([[CHAIN_ID, brokenAlchemy]]));

    const result = await service.listHoldings(OWNER_ID, 'w1', CHAIN_ID);

    expect(result.source).toBe('ledger');
    expect(result.holdings).toEqual([{ contract: CONTRACT, tokenId: '7', standard: 'erc721', amount: '1' }]);
  });
});
