// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mintFeedStore } from '../src/lib/mint-feed-store';

const H1 = `0x${'a'.repeat(64)}`;
const H2 = `0x${'b'.repeat(64)}`;

const api = vi.hoisted(() => ({ receiptStatus: 'success' as 'success' | 'pending' | 'reverted', receiptCalls: 0, scheduleCalls: 0 }));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { body?: { hashes?: string[] } } = {}) => {
      if (path === '/schedules/mints?mine=1') {
        api.scheduleCalls++;
        return { jobs: [] };
      }
      if (/^\/chains\/\d+\/transactions\/receipts$/.test(path)) {
        api.receiptCalls++;
        return { receipts: (options.body?.hashes ?? []).map((hash) => ({ hash, status: api.receiptStatus, gasUsed: '21000', effectiveGasPriceWei: '5' })) };
      }
      throw new Error(`unexpected request: ${path}`);
    }),
  };
});

import { useMintWatcher } from '../src/lib/useMintWatcher';

function Watcher() {
  useMintWatcher();
  return null;
}
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Watcher /></QueryClientProvider>);
const mint = (hash: string, at = Date.now() - 2000) => ({ id: `tx:${hash}`, at, chainId: 46630, nftContract: '0xc', walletId: 'w', address: '0xa', quantity: 1, hash });

let charge: Mock<() => void>;
beforeEach(() => {
  mintFeedStore.clear();
  Object.assign(api, { receiptStatus: 'success', receiptCalls: 0, scheduleCalls: 0 });
  charge = vi.fn<() => void>();
  window.chargeLogo = charge;
});
afterEach(() => {
  cleanup();
  delete window.chargeLogo;
});

describe('app-level mint watcher', () => {
  it('confirms a mint broadcast from this device, records its gas, and replays the logo once', async () => {
    mintFeedStore.recordMints([mint(H1)]);
    mount();
    await waitFor(() => expect(mintFeedStore.getSnapshot().receipts[H1]).toMatchObject({ status: 'success', gasUsed: '21000' }));
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it('replays the logo once for a batch that confirms together', async () => {
    mintFeedStore.recordMints([mint(H1), mint(H2)]);
    mount();
    await waitFor(() => expect(Object.keys(mintFeedStore.getSnapshot().receipts)).toHaveLength(2));
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it('does not replay the logo for a mint that reverted on-chain', async () => {
    api.receiptStatus = 'reverted';
    mintFeedStore.recordMints([mint(H1)]);
    mount();
    await waitFor(() => expect(mintFeedStore.getSnapshot().receipts[H1]?.status).toBe('reverted'));
    expect(charge).not.toHaveBeenCalled();
  });

  it('does not replay the logo when old history loads in already confirmed after a reload', async () => {
    // What a reload looks like: the mint is in storage from an hour ago, and nothing has been seen pending this session.
    window.localStorage.setItem('stryx-mint-feed-v2:acct-1', JSON.stringify({ device: [mint(H1, Date.now() - 3_600_000)], receipts: {}, charged: {} }));
    const { createMintFeedStore } = await import('../src/lib/mint-feed-store');
    const { processRound, pendingTargets } = await import('../src/lib/receipt-watch');
    const reloaded = createMintFeedStore(window.localStorage, { id: 'acct-1' });
    expect(reloaded.getSnapshot().seenPending.size).toBe(0);
    const targets = pendingTargets({ device: reloaded.getSnapshot().device, jobs: [], receipts: {}, unconfirmed: new Set() });
    await processRound({ store: reloaded, targets, fetchReceipts: async (_chain, hashes) => hashes.map((h) => ({ hash: h, status: 'success' as const })), charge });
    expect(charge).not.toHaveBeenCalled();
    expect(reloaded.getSnapshot().receipts[H1]?.status).toBe('success');
  });

  it('keeps polling the schedule list, but makes no receipt request when nothing is pending', async () => {
    mount();
    await waitFor(() => expect(api.scheduleCalls).toBeGreaterThan(0));
    expect(api.receiptCalls).toBe(0);
  });

  it('stops asking about a mint once it has its receipt', async () => {
    mintFeedStore.recordMints([mint(H1)]);
    mount();
    await waitFor(() => expect(mintFeedStore.getSnapshot().receipts[H1]).toBeDefined());
    const calls = api.receiptCalls;
    await new Promise((r) => setTimeout(r, 300));
    expect(api.receiptCalls).toBe(calls);
  });
});
