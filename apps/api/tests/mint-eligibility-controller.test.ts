import { describe, expect, it } from 'vitest';
import { noopLogger } from '@stryx/logger';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { buildApp } from '../src/app.js';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import type { CheckPhaseParams, MintEligibilityService, PhaseEligibilityOutcome, WalletEligibilityRow } from '../src/mint-eligibility.service.js';

const CHAIN_ID = 46630;
const NFT_CONTRACT = '0x1234567890123456789012345678901234567890';
const PUBLIC_PHASE = {
  id: 'public',
  name: 'Phase 1',
  kind: 'public' as const,
  priceWei: '0',
  startMs: null,
  endMs: null,
  maxPerWallet: null,
  source: 'on-chain' as const,
  mechanism: null,
  openSeaStageUuid: null,
};

function fakeRow(walletId: string): WalletEligibilityRow {
  return { walletId, address: '0xabc', balanceWei: '0', minted: 0, limit: null, remaining: null, eligible: 'eligible', priceWei: '0' };
}

async function buildRig(checkPhase: (params: CheckPhaseParams) => Promise<PhaseEligibilityOutcome>) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const mintEligibilityService = { checkPhase } as unknown as MintEligibilityService;
  const app = buildApp({ walletService, logger: noopLogger, mintEligibilityService });
  const wallet = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);
  return { app, walletId: wallet.id };
}

describe('POST /chains/:chainId/collections/:contract/eligibility', () => {
  it('returns the service\'s per-wallet rows inside a 200', async () => {
    let received: CheckPhaseParams | undefined;
    const rig = await buildRig(async (params) => {
      received = params;
      return { results: params.walletIds.map((id) => fakeRow(id)) };
    });

    const res = await rig.app.inject({
      method: 'POST',
      url: `/chains/${CHAIN_ID}/collections/${NFT_CONTRACT}/eligibility`,
      payload: { slug: 'kid-story-760618637', walletIds: [rig.walletId], phase: PUBLIC_PHASE },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
    expect(res.json().results[0].walletId).toBe(rig.walletId);
    expect(received?.chainId).toBe(CHAIN_ID);
    expect(received?.nftContract).toBe(NFT_CONTRACT);
    expect(received?.slug).toBe('kid-story-760618637');
    expect(received?.phase).toEqual(PUBLIC_PHASE);
    expect(received?.ownerId).toBe(RESERVED_OPERATOR_USER_ID);
  });

  it('accepts a null slug (a collection with no OpenSea listing)', async () => {
    const rig = await buildRig(async (params) => ({ results: params.walletIds.map((id) => fakeRow(id)) }));

    const res = await rig.app.inject({
      method: 'POST',
      url: `/chains/${CHAIN_ID}/collections/${NFT_CONTRACT}/eligibility`,
      payload: { slug: null, walletIds: [rig.walletId], phase: PUBLIC_PHASE },
    });

    expect(res.statusCode).toBe(200);
  });

  it('surfaces a preflight error as a 400', async () => {
    const rig = await buildRig(async () => ({ preflightError: 'missing_slug', detail: 'no OpenSea listing', results: [] }));

    const res = await rig.app.inject({
      method: 'POST',
      url: `/chains/${CHAIN_ID}/collections/${NFT_CONTRACT}/eligibility`,
      payload: { slug: null, walletIds: [rig.walletId], phase: PUBLIC_PHASE },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('missing_slug');
  });

  it('rejects a request with no wallets (schema validation, before ever reaching the service)', async () => {
    const rig = await buildRig(async () => ({ results: [] }));

    const res = await rig.app.inject({
      method: 'POST',
      url: `/chains/${CHAIN_ID}/collections/${NFT_CONTRACT}/eligibility`,
      payload: { slug: null, walletIds: [], phase: PUBLIC_PHASE },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed contract address', async () => {
    const rig = await buildRig(async () => ({ results: [] }));

    const res = await rig.app.inject({
      method: 'POST',
      url: `/chains/${CHAIN_ID}/collections/not-an-address/eligibility`,
      payload: { slug: null, walletIds: [rig.walletId], phase: PUBLIC_PHASE },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a phase object missing required fields', async () => {
    const rig = await buildRig(async () => ({ results: [] }));

    const res = await rig.app.inject({
      method: 'POST',
      url: `/chains/${CHAIN_ID}/collections/${NFT_CONTRACT}/eligibility`,
      payload: { slug: null, walletIds: [rig.walletId], phase: { id: 'public' } },
    });

    expect(res.statusCode).toBe(400);
  });
});
