import { describe, expect, it } from 'vitest';
import { encodeErrorResult } from 'viem';
import { SEADROP_ABI } from '@stryx/nft-engine';
import { SimulationRevertedError } from '@stryx/transaction-engine';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { RESERVED_OPERATOR_USER_ID } from '../src/reserved-users.js';
import { MintExecutionService, type StartPatience } from '../src/mint-execution.service.js';
import { SCHEDULED_MINT_CONCURRENCY, SCHEDULED_PATIENCE } from '../src/mint-scheduler.js';
import { InMemoryAllowListStore } from '../src/allowlist-store.js';
import { FakeOpenSeaDropClient } from './fakes/fake-opensea-drop-client.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';
import { makePermissiveSpendCapResolver } from './fakes/permissive-spend-cap-resolver.js';
import type { ChainServices } from '../src/chain-services.js';

const CHAIN_ID = 46630;
const CONTRACT = '0x1234567890123456789012345678901234567890' as `0x${string}`;

function revert(errorName: 'NotActive' | 'MintQuantityCannotBeZero'): SimulationRevertedError {
  const data = encodeErrorResult(errorName === 'NotActive' ? { abi: SEADROP_ABI, errorName, args: [1n, 2n, 3n] } : { abi: SEADROP_ABI, errorName });
  const cause = Object.assign(new Error('execution reverted'), { walk: (fn: (e: unknown) => boolean) => (fn({ data }) ? { data } : undefined) });
  return new SimulationRevertedError({} as never, cause);
}

/** A drop whose public stage opens `opensInMs` from now, and an engine that throws what the test scripts. */
async function rig(opts: { opensInMs?: number; engineThrows?: (call: number) => Error | undefined } = {}) {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletService = new WalletService(repository, new WalletKeyService(kms), kms.keyId);
  const wallet = await walletService.createWallet({ tier: 'HOT' }, RESERVED_OPERATOR_USER_ID);
  const startTime = Math.floor((Date.now() + (opts.opensInMs ?? -60_000)) / 1000);
  let engineCalls = 0;
  let activeChecks = 0;
  const chain = {
    seaDropReader: {
      getPublicDrop: async () => ({ mintPrice: 0n, startTime, endTime: startTime + 3600, maxTotalMintableByWallet: 5, feeBps: 0, restrictFeeRecipients: false }),
      isPublicStageActive: async () => {
        activeChecks++;
        return Date.now() >= startTime * 1000;
      },
      getAllowedFeeRecipients: async () => ['0x0000a26b00c1f0df003000390027140000faa719'],
    },
    transactionEngine: {
      executeTransaction: async () => {
        const err = opts.engineThrows?.(engineCalls++);
        if (err) throw err;
        return { hash: '0x' + '11'.repeat(32), nonce: 0, status: 'broadcast' };
      },
    },
    publicClient: {},
  } as unknown as ChainServices;
  const service = new MintExecutionService(walletService, new Map([[CHAIN_ID, chain]]), new InMemoryAllowListStore(), new FakeOpenSeaDropClient(), makePermissiveSpendCapResolver());
  const slept: number[] = [];
  const patience: StartPatience = { waitForStartMs: 5_000, notActiveRetries: 3, notActiveRetryMs: 500, sleep: async (ms) => void slept.push(ms) };
  const request = { ownerId: RESERVED_OPERATOR_USER_ID, walletId: wallet.id, nftContract: CONTRACT, chainId: CHAIN_ID, quantity: 1 };
  return { service, walletService, wallet, request, patience, slept, calls: () => engineCalls, activeChecks: () => activeChecks };
}

describe('a scheduled mint around the moment its stage opens', () => {
  it('fired two seconds early, it waits for the start and mints, instead of concluding "not open"', async () => {
    const r = await rig({ opensInMs: 2_000 });
    const outcome = await r.service.executePublicMint(r.request, r.patience);
    expect(outcome.ok).toBe(true);
    expect(r.slept).toHaveLength(1);
    expect(r.slept[0]).toBeGreaterThan(900);
    expect(r.slept[0]).toBeLessThanOrEqual(2_000);
  });

  it('a start too far off to wait for is still "not open": the scheduler reschedules it', async () => {
    const r = await rig({ opensInMs: 60_000 });
    expect(await r.service.executePublicMint(r.request, r.patience)).toMatchObject({ ok: false, reason: 'no_active_public_stage' });
    expect(r.slept).toEqual([]);
    expect(r.calls()).toBe(0);
  });

  it('a mint someone pressed "now" for never waits', async () => {
    const r = await rig({ opensInMs: 2_000 });
    expect(await r.service.executePublicMint(r.request)).toMatchObject({ ok: false, reason: 'no_active_public_stage' });
  });

  it('NotActive from the pre-send check (latest block stamped before the start) is asked again, then mints', async () => {
    const r = await rig({ engineThrows: (call) => (call < 2 ? revert('NotActive') : undefined) });
    expect((await r.service.executePublicMint(r.request, r.patience)).ok).toBe(true);
    expect(r.calls()).toBe(3);
    expect(r.slept).toEqual([500, 500]);
  });

  it('it gives up once the retries are spent, and any other revert is final at once', async () => {
    const stuck = await rig({ engineThrows: () => revert('NotActive') });
    expect(await stuck.service.executePublicMint(stuck.request, stuck.patience)).toMatchObject({ ok: false, reason: 'simulation_reverted' });
    expect(stuck.calls()).toBe(4); // the first try and three more

    const other = await rig({ engineThrows: () => revert('MintQuantityCannotBeZero') });
    expect(await other.service.executePublicMint(other.request, other.patience)).toMatchObject({ ok: false, reason: 'simulation_reverted' });
    expect(other.calls()).toBe(1);

    const now = await rig({ engineThrows: () => revert('NotActive') });
    await now.service.executePublicMint(now.request);
    expect(now.calls()).toBe(1); // no patience: an immediate mint is told the truth straight away
  });

  it('the scheduler waits out one Ethereum slot and runs several jobs at once', () => {
    expect(SCHEDULED_PATIENCE.notActiveRetries * SCHEDULED_PATIENCE.notActiveRetryMs).toBeGreaterThanOrEqual(12_000);
    expect(SCHEDULED_PATIENCE.waitForStartMs).toBeGreaterThan(2_000); // longer than the lead it fires ahead by
    expect(SCHEDULED_MINT_CONCURRENCY).toBeGreaterThan(1);
  });
});

describe('a wallet that is no longer active', () => {
  it('is not minted from, whatever was scheduled before it was archived', async () => {
    const r = await rig();
    await r.walletService.archiveWallet(RESERVED_OPERATOR_USER_ID, r.wallet.id);
    expect(await r.service.executePublicMint(r.request, r.patience)).toMatchObject({ ok: false, reason: 'wallet_not_active' });
    expect(r.calls()).toBe(0);
  });
});
