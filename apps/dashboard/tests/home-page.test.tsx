// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../src/lib/api';
import { floorMultiple, formatPrice, formatSupply, mintedPercent, startsIn, timeAgo, chainLabel } from '../src/lib/home-feed';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const api = vi.hoisted(() => ({ calls: [] as string[], error: null as Error | null }));

function feedFor(window: string) {
  return {
    window,
    fetchedAt: iso(NOW - 2 * 60_000),
    warning: null,
    upcoming: [
      {
        slug: 'live-one', name: 'Live One', chain: 'base', chainId: 8453, contractAddress: '0xabc', imageUrl: null,
        openSeaUrl: 'https://opensea.io/collection/live-one', maxSupply: 1000, totalSupply: 250, isMinting: true,
        stage: { label: 'Public', stageType: 'public_sale', startTime: iso(NOW - HOUR), endTime: iso(NOW + HOUR), price: { amount: '0.001', symbol: 'ETH' }, maxPerWallet: 5 },
      },
      {
        slug: 'soon', name: 'Soon Drop', chain: 'some_chain', chainId: null, contractAddress: '0xdef', imageUrl: null,
        openSeaUrl: 'https://opensea.io/collection/soon', maxSupply: null, totalSupply: null, isMinting: false,
        stage: { label: 'GTD', stageType: 'presale', startTime: iso(NOW + 3 * HOUR), endTime: iso(NOW + 5 * HOUR), price: { amount: '0', symbol: 'ETH' }, maxPerWallet: 1 },
      },
    ],
    pastMints:
      window === '30d'
        ? [pastMint('fresh', 2), pastMint('older', 20)]
        : [pastMint('fresh', 2)],
  };
}

function pastMint(slug: string, daysAgo: number) {
  return {
    slug, name: slug.toUpperCase(), chain: 'ethereum', chainId: 1, contractAddress: '0x1', imageUrl: null,
    openSeaUrl: `https://opensea.io/collection/${slug}`, maxSupply: 3333, totalSupply: 3333,
    mintedAt: iso(NOW - daysAgo * 24 * HOUR), endsAt: null, status: 'sold_out',
    mintPrice: { amount: '0.01', symbol: 'ETH' }, floor: { amount: '0.025', symbol: 'ETH' }, owners: 1500, volume: null, sales: 10,
  };
}

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string) => {
      api.calls.push(path);
      if (api.error) throw api.error;
      const m = /^\/home\/drops\?window=(7d|30d)$/.exec(path);
      if (m) return feedFor(m[1]!);
      throw new Error(`unexpected ${path}`);
    }),
  };
});

const { HomePage } = await import('../src/pages/HomePage');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  api.calls = [];
  api.error = null;
  vi.useRealTimers();
});

describe('HomePage', () => {
  it('shows live and upcoming drops, and past mints for 7 days by default', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    renderPage();
    await screen.findByText('Live One');
    // A member's Home also loads their account (for the greeting); the drops come from one request.
    expect(api.calls.filter((c) => c.startsWith('/home/drops'))).toEqual(['/home/drops?window=7d']);

    const live = screen.getByRole('region', { name: 'Live now' });
    expect(within(live).getByText('Live One')).toBeTruthy();
    expect(within(live).getByText('250 / 1,000')).toBeTruthy();

    const upcoming = screen.getByRole('region', { name: 'Upcoming drops' });
    expect(within(upcoming).getByText('Soon Drop')).toBeTruthy();
    expect(within(upcoming).getByText('Free')).toBeTruthy();
    expect(within(upcoming).getByText('in 3h 0m')).toBeTruthy();

    const past = screen.getByRole('region', { name: 'Past mints' });
    expect(within(past).getByText('FRESH')).toBeTruthy();
    expect(within(past).queryByText('OLDER')).toBeNull();
    expect(within(past).getByText('2.5x', { exact: false })).toBeTruthy();
  });

  it('opens with the feed saved by the last visit, then refreshes it when it is older than 5 minutes', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const saved = { ...feedFor('7d'), upcoming: [{ ...feedFor('7d').upcoming[0]!, name: 'Saved Drop' }], fetchedAt: iso(NOW - 20 * 60_000) };
    localStorage.setItem('stryx-home-feed-v1:7d', JSON.stringify(saved));
    renderPage();
    // Shown straight away from the saved copy, before the server has answered...
    expect(screen.getByText('Saved Drop')).toBeTruthy();
    expect(screen.getByText(/Updated 20m ago/)).toBeTruthy();
    // ...then replaced by the fresh one, which is saved for next time.
    expect(await screen.findByText('Live One')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('stryx-home-feed-v1:7d')!).upcoming[0].name).toBe('Live One');
  });

  it('does not ask the server again for a saved feed under 5 minutes old', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    localStorage.setItem('stryx-home-feed-v1:7d', JSON.stringify({ ...feedFor('7d'), fetchedAt: iso(NOW - 60_000) }));
    renderPage();
    expect(screen.getByText('Live One')).toBeTruthy();
    expect(api.calls.filter((c) => c.startsWith('/home/drops'))).toEqual([]);
  });

  it('switches the past-mints window to 30 days', async () => {
    renderPage();
    await screen.findByText('FRESH');
    fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
    await screen.findByText('OLDER');
    expect(api.calls).toContain('/home/drops?window=30d');
    expect(screen.getByRole('radio', { name: '30 days' }).getAttribute('aria-checked')).toBe('true');
  });

  it('offers "Open in Mint" only for chains this platform runs', async () => {
    renderPage();
    await screen.findByText('Live One');
    const live = screen.getByRole('region', { name: 'Live now' });
    const mintLink = within(live).getByRole('link', { name: 'Open in Mint' });
    expect(mintLink.getAttribute('href')).toBe(`/mint?collection=${encodeURIComponent('https://opensea.io/collection/live-one')}`);

    const upcoming = screen.getByRole('region', { name: 'Upcoming drops' });
    expect(within(upcoming).queryByRole('link', { name: 'Open in Mint' })).toBeNull();
    const os = within(upcoming).getByRole('link', { name: 'OpenSea' });
    expect(os.getAttribute('target')).toBe('_blank');
    expect(os.getAttribute('rel')).toContain('noopener');
  });

  it('shows the API message and a retry when the feed fails', async () => {
    api.error = new ApiError(503, { error: 'feed_not_configured', message: 'The Home page feed needs OPENSEA_API_KEY.' });
    renderPage();
    await screen.findByText('The Home page feed needs OPENSEA_API_KEY.');
    api.error = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Live One')).toBeTruthy());
  });
});

describe('home-feed helpers', () => {
  it('formats prices, including free and unknown', () => {
    expect(formatPrice({ amount: '0.002', symbol: 'ETH' })).toBe('0.002 ETH');
    expect(formatPrice({ amount: '0', symbol: 'ETH' })).toBe('Free');
    expect(formatPrice(null)).toBe('-');
  });

  it('formats supply against the cap when there is one', () => {
    expect(formatSupply(120, 1000)).toBe('120 / 1,000');
    expect(formatSupply(null, 5000)).toBe('5,000 max');
    expect(formatSupply(42, null)).toBe('42 minted');
    expect(formatSupply(null, null)).toBe('-');
    expect(mintedPercent(250, 1000)).toBe(25);
    expect(mintedPercent(10, 0)).toBeNull();
  });

  it('gives a floor multiple only for a paid mint in the same currency', () => {
    expect(floorMultiple({ amount: '0.01', symbol: 'ETH' }, { amount: '0.025', symbol: 'ETH' })).toBe('2.5x');
    expect(floorMultiple({ amount: '0.001', symbol: 'ETH' }, { amount: '0.05', symbol: 'ETH' })).toBe('50x');
    expect(floorMultiple({ amount: '0', symbol: 'ETH' }, { amount: '0.05', symbol: 'ETH' })).toBeNull();
    expect(floorMultiple({ amount: '1', symbol: 'POL' }, { amount: '0.05', symbol: 'ETH' })).toBeNull();
  });

  it('describes times relative to now', () => {
    expect(startsIn(iso(NOW + 30 * 60_000), NOW)).toBe('in 30m');
    expect(startsIn(iso(NOW + 26 * HOUR), NOW)).toBe('in 1d 2h');
    expect(startsIn(iso(NOW - 1000), NOW)).toBe('now');
    expect(timeAgo(iso(NOW - 3 * HOUR), NOW)).toBe('3h ago');
    expect(timeAgo(iso(NOW - 50 * HOUR), NOW)).toBe('2d ago');
  });

  it('turns an OpenSea chain slug into a label', () => {
    expect(chainLabel('bera_chain')).toBe('Bera chain');
  });
});
