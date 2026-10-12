// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { receiptsFromServer, type ServerMint } from '../src/lib/server-mints';

const api = { calls: [] as string[], openSeaName: null as string | null };

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, init?: { method?: string }) => {
      api.calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.startsWith('/drops/')) return { openSea: api.openSeaName ? { collectionName: api.openSeaName } : null };
      if (path === '/resolve/collection') return { contract: '0x1', chainId: 4663, chainName: 'Robinhood Chain', openSeaUrl: null, name: 'Kid Story', image: null, mintedCount: null, maxSupply: null, mintableHere: true };
      throw new Error(`unexpected ${path}`);
    }),
  };
});

const { useCollectionName } = await import('../src/lib/useCollectionName');

function Name() {
  const { name } = useCollectionName(4663, '0x' + '1'.repeat(40));
  return <span>{name ?? 'no name'}</span>;
}
const renderName = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Name />
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  api.calls = [];
  api.openSeaName = null;
});

describe('collection names', () => {
  it("use OpenSea's name when it has one, without asking anything else", async () => {
    api.openSeaName = 'Live Drop';
    renderName();
    expect(await screen.findByText('Live Drop')).toBeTruthy();
    expect(api.calls).not.toContain('POST /resolve/collection');
  });

  it("fall back to the collection's own name when OpenSea no longer lists the drop", async () => {
    renderName();
    expect(await screen.findByText('Kid Story')).toBeTruthy();
    expect(api.calls).toContain('POST /resolve/collection');
  });
});

describe('receiptsFromServer', () => {
  const mint = (over: Partial<ServerMint>): ServerMint => ({
    id: 'm', walletId: 'w', walletAddress: '0x' + 'b'.repeat(40), chainId: 46630, contract: '0x' + '1'.repeat(40), kind: 'PUBLIC', quantity: 1, source: 'SCHEDULED',
    jobId: 'j', status: 'CONFIRMED', failureReason: null, failureNote: null, txHash: '0xAB', gasUsed: '50000', createdAt: '2026-10-02T00:00:00Z', broadcastAt: null, ...over,
  });

  it('turns settled mints into receipts, keyed by lower-case hash, and skips what the browser already knows or is unsettled', () => {
    const out = receiptsFromServer(
      [mint({}), mint({ txHash: '0xCD', status: 'REVERTED' }), mint({ txHash: '0xEF', status: 'PENDING' }), mint({ txHash: null }), mint({ txHash: '0x12' })],
      { '0x12': { status: 'success' } },
    );
    expect(out).toEqual({ '0xab': { status: 'success', gasUsed: '50000' }, '0xcd': { status: 'reverted', gasUsed: '50000' } });
  });
});
