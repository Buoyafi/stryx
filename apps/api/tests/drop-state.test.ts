import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseEther } from 'viem';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { noopLogger } from '@stryx/logger';
import { buildApp } from '../src/app.js';
import type { ChainServices } from '../src/chain-services.js';
import { BalanceService } from '../src/balance.service.js';
import { DisperseService } from '../src/disperse.service.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';

const CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890';
const ZERO_ROOT = `0x${'00'.repeat(32)}`;

function makeChain(opts: {
  startTime?: number;
  active?: boolean;
  merkleRoot?: string;
  feeRecipients?: string[];
  readThrows?: boolean;
}): ChainServices {
  return {
    publicClient: {} as never,
    transactionEngine: {} as never,
    seaDropReader: {
      async getPublicDrop() {
        if (opts.readThrows) throw new Error('not a seadrop contract');
        return {
          mintPrice: parseEther('0.01'),
          startTime: opts.startTime ?? 1_700_000_000,
          endTime: 2_000_000_000,
          maxTotalMintableByWallet: 5,
          feeBps: 250,
          restrictFeeRecipients: false,
        };
      },
      async isPublicStageActive() {
        return opts.active ?? true;
      },
      async getAllowListMerkleRoot() {
        return opts.merkleRoot ?? ZERO_ROOT;
      },
      async getAllowedFeeRecipients() {
        return opts.feeRecipients ?? ['0x0000a26b00c1F0DF003000390027140000fAa719'];
      },
    } as never,
  };
}

async function buildRig(
  chain?: ChainServices,
  fetchOpenSeaDropInfo?: (chainId: number, contract: string) => Promise<unknown>,
): Promise<FastifyInstance> {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);

  const chainServices = new Map<number, ChainServices>();
  if (chain) chainServices.set(CHAIN_ID, chain);

  return buildApp({
    walletService,
    logger: noopLogger,
    chainServices,
    balanceService: new BalanceService(chainServices),
    disperseService: new DisperseService(walletService, chainServices, makePermissiveSpendCapResolver()),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(fetchOpenSeaDropInfo ? { fetchOpenSeaDropInfo: fetchOpenSeaDropInfo as any } : {}),
  });
}

describe('GET /drops/:chainId/:contract', () => {
  it('reports a live public stage with its price and limits', async () => {
    const app = await buildRig(makeChain({ active: true }));

    const res = await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.publicStage.configured).toBe(true);
    expect(body.publicStage.active).toBe(true);
    expect(body.publicStage.mintPriceWei).toBe(parseEther('0.01').toString());
    expect(body.publicStage.maxPerWallet).toBe(5);
  });

  it('reports a configured-but-not-live stage distinctly from a live one', async () => {
    const app = await buildRig(makeChain({ active: false }));

    const body = (await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` })).json();

    expect(body.publicStage.configured).toBe(true);
    expect(body.publicStage.active).toBe(false);
  });

  it('reports startTime 0 as not configured', async () => {
    const app = await buildRig(makeChain({ startTime: 0, active: false }));

    const body = (await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` })).json();

    expect(body.publicStage.configured).toBe(false);
  });

  it('detects a configured allow-list via a non-zero merkle root', async () => {
    const app = await buildRig(makeChain({ merkleRoot: `0x${'ab'.repeat(32)}` }));

    const body = (await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` })).json();

    expect(body.allowList.configured).toBe(true);
  });

  it('reports no allow-list when the root is zero', async () => {
    const app = await buildRig(makeChain({}));

    const body = (await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` })).json();

    expect(body.allowList.configured).toBe(false);
  });

  it('returns 400 for a chain with no RPC configured', async () => {
    const app = await buildRig(makeChain({}));

    const res = await app.inject({ method: 'GET', url: `/drops/999999/${CONTRACT}` });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_chain');
  });

  it('returns 502 when the contract cannot be read as a SeaDrop drop', async () => {
    const app = await buildRig(makeChain({ readThrows: true }));

    const res = await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('drop_read_failed');
  });

  it('enriches the on-chain answer with OpenSea data when available, under an "openSea" field', async () => {
    const app = await buildRig(makeChain({}), async () => ({ collectionName: 'Facets', imageUrl: 'https://example/img.png', totalSupply: 805, maxSupply: 4269, stages: [] }));

    const body = (await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` })).json();

    expect(body.openSea).toEqual({ collectionName: 'Facets', imageUrl: 'https://example/img.png', totalSupply: 805, maxSupply: 4269, stages: [] });
  });

  it('reports openSea: null (never a 502) when no enrichment function is wired up at all', async () => {
    const app = await buildRig(makeChain({}));

    const body = (await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` })).json();

    expect(body.openSea).toBeNull();
  });

  it('reports openSea: null, still a 200 with the on-chain answer, when OpenSea has nothing for this contract', async () => {
    const app = await buildRig(makeChain({}), async () => null);

    const res = await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().openSea).toBeNull();
  });

  it('reports openSea: null, never lets an OpenSea failure turn a good on-chain read into a 502', async () => {
    const app = await buildRig(makeChain({}), async () => {
      throw new Error('OpenSea is down');
    });

    const res = await app.inject({ method: 'GET', url: `/drops/${CHAIN_ID}/${CONTRACT}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().openSea).toBeNull();
  });
});
