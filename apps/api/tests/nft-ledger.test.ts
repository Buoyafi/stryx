import { describe, expect, it } from 'vitest';
import { NftLedgerService } from '../src/nft-ledger.service.js';
import { InMemoryNftLedgerRepository } from './fakes/in-memory-nft-ledger-repository.js';

const CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890';

describe('NftLedgerService', () => {
  it('records one row per token a mint produced', async () => {
    const repo = new InMemoryNftLedgerRepository();
    const service = new NftLedgerService(repo);

    await service.recordMint(
      { walletId: 'w1', ownerId: 'owner-1', chainId: CHAIN_ID, contract: CONTRACT, standard: 'erc721' },
      [{ tokenId: '1', amount: '1' }, { tokenId: '2', amount: '1' }],
    );

    expect(repo.rows).toHaveLength(2);
    expect(repo.rows.map((r) => r.tokenId)).toEqual(['1', '2']);
  });

  it('lists only what a wallet currently still holds on that chain', async () => {
    const repo = new InMemoryNftLedgerRepository();
    const service = new NftLedgerService(repo);
    await service.recordMint({ walletId: 'w1', ownerId: 'owner-1', chainId: CHAIN_ID, contract: CONTRACT, standard: 'erc721' }, [{ tokenId: '1', amount: '1' }]);
    await service.recordMint({ walletId: 'w1', ownerId: 'owner-1', chainId: 999, contract: CONTRACT, standard: 'erc721' }, [{ tokenId: '2', amount: '1' }]);
    await service.recordMint({ walletId: 'w2', ownerId: 'owner-1', chainId: CHAIN_ID, contract: CONTRACT, standard: 'erc721' }, [{ tokenId: '3', amount: '1' }]);

    const held = await service.listHeld('w1', CHAIN_ID);
    expect(held.map((r) => r.tokenId)).toEqual(['1']);
  });

  it('marking a token transferred removes it from the held list', async () => {
    const repo = new InMemoryNftLedgerRepository();
    const service = new NftLedgerService(repo);
    await service.recordMint({ walletId: 'w1', ownerId: 'owner-1', chainId: CHAIN_ID, contract: CONTRACT, standard: 'erc721' }, [{ tokenId: '1', amount: '1' }]);

    await service.markTransferred({ chainId: CHAIN_ID, contract: CONTRACT, tokenId: '1', walletId: 'w1' }, '0xdestination');

    expect(await service.listHeld('w1', CHAIN_ID)).toEqual([]);
    expect(repo.rows[0]!.transferredTo).toBe('0xdestination');
  });

  it('marking an unknown token transferred is a harmless no-op', async () => {
    const repo = new InMemoryNftLedgerRepository();
    const service = new NftLedgerService(repo);

    await expect(
      service.markTransferred({ chainId: CHAIN_ID, contract: CONTRACT, tokenId: 'does-not-exist', walletId: 'w1' }, '0xdest'),
    ).resolves.toBeUndefined();
  });
  it('keeps a drain failure short and free of the RPC address (which carries the provider key)', async () => {
    const repo = new InMemoryNftLedgerRepository();
    const service = new NftLedgerService(repo);
    const target = { walletId: 'w1', chainId: CHAIN_ID, contract: CONTRACT, tokenId: '1' };
    await service.recordMint({ walletId: 'w1', ownerId: 'owner-1', chainId: CHAIN_ID, contract: CONTRACT, standard: 'erc721' }, [{ tokenId: '1', amount: '1' }]);

    await service.recordDrainFailure(target, 'Chain unreachable: HTTP request failed.\n\nURL: https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123\nRequest body: ' + 'f'.repeat(2000));

    const stored = (await service.findLatestDrainFailure('owner-1', CHAIN_ID))!.drainError!;
    expect(stored).toContain('Chain unreachable');
    expect(stored).not.toContain('SECRETKEY123');
    expect(stored).not.toContain('alchemy.com');
    expect(stored).not.toContain('\n');
    expect(stored.length).toBeLessThanOrEqual(301);
  });
});
