import { describe, expect, it, vi } from 'vitest';
import { TimeoutError } from 'viem';
import type { UserId } from '@stryx/wallet-service';
import { AutoScheduleService } from '../src/auto-schedule.service.js';
import { noopLogger } from '@stryx/logger';
import type { ChainServices } from '../src/chain-services.js';
import type { MintScheduler } from '../src/mint-scheduler.js';

const CHAIN_ID = 46630;
const NFT = '0x1234567890123456789012345678901234567890' as `0x${string}`;

function makeChain(publicDrop: { startTime: number; endTime: number; mintPrice?: bigint }): ChainServices {
  return {
    seaDropReader: {
      async getPublicDrop() {
        return {
          mintPrice: publicDrop.mintPrice ?? 0n,
          startTime: publicDrop.startTime,
          endTime: publicDrop.endTime,
          maxTotalMintableByWallet: 5,
          feeBps: 0,
          restrictFeeRecipients: false,
        };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeScheduler() {
  const twins = { on: false };
  const calls: Array<{ executeAt: number; autoReschedule?: { remaining: number }; job?: { request: { maxPriceWei?: string } } }> = [];
  const scheduler = {
    async hasPendingTwin() {
      return calls.length > 0 && twins.on;
    },
    async schedule(params: { executeAt: number; autoReschedule?: { remaining: number }; job?: { request: { maxPriceWei?: string } } }) {
      calls.push(params);
      return 'job-1';
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as MintScheduler;
  return { scheduler, calls, twins };
}

const publicJob = {
  kind: 'public' as const,
  request: { ownerId: 'test-owner' as UserId, walletId: 'w1', nftContract: NFT, chainId: CHAIN_ID, quantity: 1 },
};

describe('AutoScheduleService', () => {
  it('does not schedule the same wallet for the same drop twice', async () => {
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ startTime: futureSec, endTime: futureSec + 3600 })]]);
    const { scheduler, calls, twins } = makeScheduler();
    twins.on = true;
    const svc = new AutoScheduleService(chains, scheduler, noopLogger);

    expect((await svc.autoSchedulePublicMint(publicJob)).scheduled).toBe(true);
    expect(await svc.autoSchedulePublicMint(publicJob)).toEqual({ scheduled: false, reason: 'already_scheduled' });
    expect(calls).toHaveLength(1);
  });

  it('the job carries the price it was scheduled at as its ceiling, unless the caller set one', async () => {
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ startTime: futureSec, endTime: futureSec + 3600, mintPrice: 1_000n })]]);
    const { scheduler, calls } = makeScheduler();
    const svc = new AutoScheduleService(chains, scheduler, noopLogger);

    await svc.autoSchedulePublicMint(publicJob);
    await svc.autoSchedulePublicMint({ ...publicJob, request: { ...publicJob.request, maxPriceWei: '2500' } });

    expect(calls.map((c) => c.job?.request.maxPriceWei)).toEqual(['1000', '2500']);
  });

  it('reads a future startTime and schedules for it, carrying the reschedule budget', async () => {
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ startTime: futureSec, endTime: futureSec + 3600 })]]);
    const { scheduler, calls } = makeScheduler();
    const svc = new AutoScheduleService(chains, scheduler, noopLogger);

    const result = await svc.autoSchedulePublicMint(publicJob, 5);

    expect(result.scheduled).toBe(true);
    expect(result.startTimeUnix).toBe(futureSec);
    expect(calls).toHaveLength(1);
    // Scheduled slightly before startTime, with the reschedule budget attached.
    expect(calls[0]!.executeAt).toBe(futureSec * 1000 - 2000);
    expect(calls[0]!.autoReschedule).toEqual({ remaining: 5 });
  });

  it('refuses to schedule when startTime is 0 (stage not configured)', async () => {
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ startTime: 0, endTime: 0 })]]);
    const { scheduler, calls } = makeScheduler();
    const svc = new AutoScheduleService(chains, scheduler, noopLogger);

    const result = await svc.autoSchedulePublicMint(publicJob);

    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('no_start_time');
    expect(calls).toHaveLength(0);
  });

  it('refuses to schedule when the stage has already ended', async () => {
    const pastSec = Math.floor(Date.now() / 1000) - 100;
    const chains = new Map<number, ChainServices>([[CHAIN_ID, makeChain({ startTime: pastSec - 3600, endTime: pastSec })]]);
    const { scheduler, calls } = makeScheduler();
    const svc = new AutoScheduleService(chains, scheduler, noopLogger);

    const result = await svc.autoSchedulePublicMint(publicJob);

    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('stage_already_ended');
    expect(calls).toHaveLength(0);
  });

  it('gives up with chain_unavailable, not hanging forever, once every retry attempt has also timed out', async () => {
    vi.useFakeTimers();
    try {
      const chain = {
        seaDropReader: { getPublicDrop: () => new Promise(() => {}) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as ChainServices;
      const chains = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
      const { scheduler, calls } = makeScheduler();
      const svc = new AutoScheduleService(chains, scheduler, noopLogger);

      const resultPromise = svc.autoSchedulePublicMint(publicJob);
      // 5 attempts of 8s plus 4 retry delays of 0.5s: 42s worst case.
      await vi.advanceTimersByTimeAsync(45_000);
      const result = await resultPromise;

      expect(result).toEqual({ scheduled: false, reason: 'chain_unavailable' });
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers from a transient chain-read failure via retry, rather than reporting chain_unavailable on the very first blip', async () => {
    let attempts = 0;
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const chain = {
      seaDropReader: {
        async getPublicDrop() {
          attempts++;
          if (attempts < 3) throw new TimeoutError({ body: {}, url: 'https://rpc.example/v2/SECRET-API-KEY' }); // the real shape isRpcTransportFailure recognizes
          return { mintPrice: 0n, startTime: futureSec, endTime: futureSec + 3600, maxTotalMintableByWallet: 5, feeBps: 0, restrictFeeRecipients: false };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as ChainServices;
    const chains = new Map<number, ChainServices>([[CHAIN_ID, chain]]);
    const { scheduler, calls } = makeScheduler();
    const svc = new AutoScheduleService(chains, scheduler, noopLogger);

    const result = await svc.autoSchedulePublicMint(publicJob);

    expect(attempts).toBe(3); // failed twice, succeeded on the third
    expect(result.scheduled).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
