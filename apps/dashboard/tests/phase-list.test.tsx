// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const calls: { path: string }[] = [];
let responder: (path: string) => unknown = () => {
  throw new Error('unexpected call');
};

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string) => {
      calls.push({ path });
      return responder(path);
    }),
  };
});

import { PhaseList } from '../src/components/mint/PhaseList';
import { writeUsdToggle } from '../src/lib/native-price';

// Real Date.now(), not fake timers: testing-library's findBy*/waitFor and React Query's
// internal scheduling both rely on real timers to poll, and fake timers deadlock them.
const NOW = Date.now();

const PUBLIC = { id: 'public', name: 'Public', kind: 'public' as const, priceWei: (10n ** 16n).toString(), startMs: NOW - 60_000, endMs: NOW + 3_600_000, maxPerWallet: 5, source: 'on-chain' as const, mechanism: null, openSeaStageUuid: null };
const OG_LIST = { id: 'opensea-1', name: 'OG List', kind: 'allowlist' as const, priceWei: '5000000000000000', startMs: NOW + 3_600_000, endMs: NOW + 7_200_000, maxPerWallet: 2, source: 'opensea' as const, mechanism: 'merkle' as const, openSeaStageUuid: 'uuid-og' };
const ENDED = { id: 'ended-1', name: 'Early Bird', kind: 'allowlist' as const, priceWei: '1000000000000000', startMs: NOW - 7_200_000, endMs: NOW - 3_600_000, maxPerWallet: 1, source: 'opensea' as const, mechanism: 'merkle' as const, openSeaStageUuid: 'uuid-ended' };

function mount(props: Partial<React.ComponentProps<typeof PhaseList>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PhaseList chainId={46630} contract="0xAbc" symbol="ETH" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  responder = (path) => {
    if (path.endsWith('/phases')) return { chainId: 46630, contract: '0xAbc', phases: [PUBLIC, OG_LIST, ENDED] };
    if (path.endsWith('/native-price')) return { chainId: 46630, usdPerToken: 2738.82, fetchedAt: NOW, cached: false };
    if (path === '/wallets') return [];
    throw new Error(`unexpected ${path}`);
  };
});
afterEach(cleanup);

describe('PhaseList', () => {
  it('renders every non-ended phase by default, with its countdown state', async () => {
    mount();
    await screen.findByText('Public');
    expect(screen.getByText('OG List')).toBeTruthy();
    expect(screen.queryByText('Early Bird')).toBeNull(); // ended, hidden by default
    expect(screen.getByText(/ends in/)).toBeTruthy(); // Public is live
    expect(screen.getByText(/starts in/i)).toBeTruthy(); // OG List is upcoming: the phase tab capitalises it ("Starts in…")
  });

  it('a phase that ends while on screen stays, so its card is not torn down mid-use', async () => {
    const ENDING = { ...PUBLIC, id: 'ending', name: 'Last Call', endMs: Date.now() + 300 };
    responder = (path) => {
      if (path.endsWith('/phases')) return { chainId: 46630, contract: '0xAbc', phases: [ENDING, ENDED] };
      if (path.endsWith('/native-price')) return { chainId: 46630, usdPerToken: 2738.82, fetchedAt: NOW, cached: false };
      if (path === '/wallets') return [];
      return { results: [] };
    };
    mount();
    await screen.findByText('Last Call');
    await new Promise((r) => setTimeout(r, 400));
    fireEvent.click(screen.getByRole('switch', { name: 'USD' })); // any re-render
    expect(screen.getByText('Last Call')).toBeTruthy();
    expect(screen.queryByText('Early Bird')).toBeNull(); // ended before the visit: still hidden

    fireEvent.click(screen.getByRole('switch', { name: 'Show ended' }));
    await screen.findByText('Early Bird');
    fireEvent.click(screen.getByRole('switch', { name: 'Show ended' }));
    await waitFor(() => expect(screen.queryByText('Early Bird')).toBeNull());
  });

  it('shows a "Show ended" prompt reachable link when the toggle brings back the ended phase', async () => {
    mount();
    await screen.findByText('Public');
    fireEvent.click(screen.getByRole('switch', { name: 'Show ended' }));
    expect(await screen.findByText('Early Bird')).toBeTruthy();
    expect(screen.getByText('Ended')).toBeTruthy();
  });

  it('shows every phase\'s price in the native symbol, and the max-per-wallet chip', async () => {
    mount();
    const publicCard = (await screen.findByText('Public')).closest('div')!.parentElement!;
    expect(within(publicCard).getByText(/0\.01 ETH/)).toBeTruthy();
    expect(within(publicCard).getByText('5')).toBeTruthy();
  });

  it('shows the eligible chip as a placeholder, never a fabricated number', async () => {
    mount();
    await screen.findByText('Public');
    expect(screen.getAllByText('checking…').length).toBeGreaterThan(0);
  });

  it('marks an OpenSea-sourced allow-list phase as not yet on-chain confirmed', async () => {
    mount();
    expect(await screen.findByText(/not yet confirmed on-chain/)).toBeTruthy();
  });

  it('USD toggle converts the price once a price is available, off by default', async () => {
    mount();
    await screen.findByText('Public');
    expect(screen.queryByText(/\$/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'USD' }));
    await waitFor(() => expect(screen.getByText(/\$27\.39/)).toBeTruthy());
  });

  it('shows "USD unavailable" rather than a fabricated number when the chain has no price mapping', async () => {
    responder = (path) => {
      if (path.endsWith('/phases')) return { chainId: 4663, contract: '0xAbc', phases: [PUBLIC] };
      if (path.endsWith('/native-price')) return { chainId: 4663, usdPerToken: null, fetchedAt: NOW, cached: false };
      if (path === '/wallets') return [];
      throw new Error(`unexpected ${path}`);
    };
    mount({ chainId: 4663 });
    await screen.findByText('Public');
    fireEvent.click(screen.getByRole('switch', { name: 'USD' }));
    expect(await screen.findByText(/USD unavailable/)).toBeTruthy();
  });

  it('the USD toggle is remembered across a remount', async () => {
    writeUsdToggle(true);
    mount();
    await screen.findByText('Public');
    expect(screen.getByRole('switch', { name: 'USD' }).getAttribute('aria-checked')).toBe('true');
    expect(calls.some((c) => c.path.endsWith('/native-price'))).toBe(true);
  });

  it('shows an empty state when the collection has no phases at all', async () => {
    responder = (path) => {
      if (path.endsWith('/phases')) return { chainId: 46630, contract: '0xAbc', phases: [] };
      if (path === '/wallets') return [];
      throw new Error(`unexpected ${path}`);
    };
    mount();
    expect(await screen.findByText('No phases configured')).toBeTruthy();
  });

  it('shows a message, not an empty list, when every phase has ended and Show ended is off', async () => {
    responder = (path) => {
      if (path.endsWith('/phases')) return { chainId: 46630, contract: '0xAbc', phases: [ENDED] };
      if (path === '/wallets') return [];
      throw new Error(`unexpected ${path}`);
    };
    mount();
    expect(await screen.findByText(/Every phase has ended/)).toBeTruthy();
  });

  it('renders phases in chronological (start time) order, never the API\'s own array order: the fixture deliberately lists Public first, then OG List, then the earliest-starting one (Early Bird)', async () => {
    mount();
    await screen.findByText('Public');
    fireEvent.click(screen.getByRole('switch', { name: 'Show ended' })); // bring Early Bird back into view too

    const region = screen.getByRole('region', { name: 'Phases' });
    const cardButtons = (await waitFor(() => {
      const buttons = within(region).getAllByRole('button').filter((b) => /^(Public|OG List|Early Bird)/.test(b.textContent ?? ''));
      expect(buttons).toHaveLength(3);
      return buttons;
    }));

    const order = cardButtons.map((b) => b.textContent?.match(/^(Public|OG List|Early Bird)/)?.[0]);
    expect(order).toEqual(['Early Bird', 'Public', 'OG List']); // Early Bird started earliest, OG List starts latest
  });

  it('defaults the expanded phase to the one currently live (Public, here), even though it is not first in the source data', async () => {
    mount();
    await screen.findByText('Public');
    const region = screen.getByRole('region', { name: 'Phases' });
    const publicButton = within(region).getByRole('button', { expanded: true });
    expect(publicButton.textContent).toMatch(/^Public/);
  });

  it('defaults to the next upcoming phase when none is live', async () => {
    const UPCOMING_A = { ...OG_LIST, id: 'up-a', name: 'Upcoming A', startMs: NOW + 1_000, endMs: NOW + 10_000 };
    const UPCOMING_B = { ...OG_LIST, id: 'up-b', name: 'Upcoming B', startMs: NOW + 20_000, endMs: NOW + 30_000 };
    responder = (path) => {
      if (path.endsWith('/phases')) return { chainId: 46630, contract: '0xAbc', phases: [UPCOMING_B, UPCOMING_A] }; // out of order too
      if (path === '/wallets') return [];
      throw new Error(`unexpected ${path}`);
    };
    mount();
    await screen.findByText('Upcoming A');
    const region = screen.getByRole('region', { name: 'Phases' });
    const openButton = within(region).getByRole('button', { expanded: true });
    expect(openButton.textContent).toMatch(/^Upcoming A/); // the EARLIER upcoming one, not just the first in source order
  });

  it('says plainly when OpenSea could not be reached, instead of passing the public phase off as the whole drop, and retries on request', async () => {
    let openSea = 'unavailable';
    responder = (path) => {
      if (path.endsWith('/phases')) return openSea === 'ok' ? { chainId: 46630, contract: '0xAbc', phases: [PUBLIC, OG_LIST], openSea } : { chainId: 46630, contract: '0xAbc', phases: [PUBLIC], openSea };
      if (path === '/wallets') return [];
      throw new Error(`unexpected ${path}`);
    };
    mount();
    expect(await screen.findByText(/Can't reach OpenSea, so GTD and FCFS phases may be missing/)).toBeTruthy();
    openSea = 'ok';
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(await screen.findByText('OG List')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Can't reach OpenSea/)).toBeNull());
  });

  it('marks remembered stages as stale while OpenSea is not answering', async () => {
    responder = (path) => {
      if (path.endsWith('/phases')) return { chainId: 46630, contract: '0xAbc', phases: [PUBLIC, OG_LIST], openSea: 'stale', openSeaAsOf: NOW - 120_000 };
      if (path === '/wallets') return [];
      throw new Error(`unexpected ${path}`);
    };
    mount();
    expect(await screen.findByText(/OpenSea isn't answering. Showing its stages from/)).toBeTruthy();
    expect(screen.getByText('OG List')).toBeTruthy();
  });
});
