import { describe, expect, it, vi } from 'vitest';
import type { UserId } from '@stryx/wallet-service';
import { WORKER_SAFETY, dispatchScheduledMint, type ScheduledMintJob } from '../src/mint-scheduler.js';
import type { MintExecutionService } from '../src/mint-execution.service.js';

function fakeService() {
  return {
    executePublicMint: vi.fn(async () => ({ ok: true, result: { hash: '0xabc', nonce: 0, status: 'broadcast' } })),
    executeAllowListMint: vi.fn(async () => ({ ok: true, result: { hash: '0xdef', nonce: 1, status: 'broadcast' } })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as MintExecutionService & {
    executePublicMint: ReturnType<typeof vi.fn>;
    executeAllowListMint: ReturnType<typeof vi.fn>;
  };
}

const base = {
  ownerId: 'test-owner' as UserId,
  walletId: 'w1',
  nftContract: '0x1234567890123456789012345678901234567890' as `0x${string}`,
  chainId: 46630,
  quantity: 1,
};

describe('dispatchScheduledMint', () => {
  it('routes a public job to executePublicMint', async () => {
    const svc = fakeService();
    const job: ScheduledMintJob = { kind: 'public', request: base };

    await dispatchScheduledMint(svc, job);

    expect(svc.executePublicMint).toHaveBeenCalledOnce();
    expect(svc.executeAllowListMint).not.toHaveBeenCalled();
  });

  it('routes an allowlist-stored job to executeAllowListMint with proofSource stored', async () => {
    const svc = fakeService();
    const job: ScheduledMintJob = { kind: 'allowlist-stored', request: { ...base, proofSource: 'stored', allowListId: 'd1' } };

    await dispatchScheduledMint(svc, job);

    expect(svc.executeAllowListMint).toHaveBeenCalledOnce();
    const arg = svc.executeAllowListMint.mock.calls[0]![0];
    expect(arg.proofSource).toBe('stored');
    expect(arg.allowListId).toBe('d1');
  });

  it('routes an allowlist-opensea job to executeAllowListMint with proofSource opensea, resolved fresh (not captured) at execution', async () => {
    const svc = fakeService();
    const job: ScheduledMintJob = { kind: 'allowlist-opensea', request: { ...base, proofSource: 'opensea', slug: 'my-drop' } };

    await dispatchScheduledMint(svc, job);

    expect(svc.executeAllowListMint).toHaveBeenCalledOnce();
    const arg = svc.executeAllowListMint.mock.calls[0]![0];
    expect(arg.proofSource).toBe('opensea');
    expect(arg.slug).toBe('my-drop');
  });

  it('rehydrates allowlist-direct mintParams bigints from strings before calling the service', async () => {
    const svc = fakeService();
    const job: ScheduledMintJob = {
      kind: 'allowlist-direct',
      request: {
        ...base,
        proofSource: 'direct',
        proof: ['0x' + 'ab'.repeat(32) as `0x${string}`],
        mintParams: {
          mintPrice: '1000000000000000',
          maxTotalMintableByWallet: 5,
          startTime: 1700000000,
          endTime: 2000000000,
          dropStageIndex: 1,
          maxTokenSupplyForStage: '1000',
          feeBps: 250,
          restrictFeeRecipients: false,
        },
      },
    };

    await dispatchScheduledMint(svc, job);

    const arg = svc.executeAllowListMint.mock.calls[0]![0];
    // The service must receive actual bigints, not the queue's string form.
    expect(typeof arg.mintParams.mintPrice).toBe('bigint');
    expect(arg.mintParams.mintPrice).toBe(1000000000000000n);
    expect(typeof arg.mintParams.maxTokenSupplyForStage).toBe('bigint');
    expect(arg.mintParams.maxTokenSupplyForStage).toBe(1000n);
  });
});

describe('the scheduled-mints worker', () => {
  it('never re-runs a job whose worker died mid-run: a mint already broadcast would mint again', () => {
    expect(WORKER_SAFETY.maxStalledCount).toBe(0);
  });
});
