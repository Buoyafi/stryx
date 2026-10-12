import { useQuery } from '@tanstack/react-query';
import { apiRequest } from './api';

/** Mirrors apps/api/src/drops-feed.service.ts. */
export type FeedWindow = '7d' | '30d';

export interface FeedPrice {
  amount: string;
  symbol: string;
}

export interface FeedStage {
  label: string;
  stageType: string;
  startTime: string;
  endTime: string;
  price: FeedPrice | null;
  maxPerWallet: number | null;
}

interface FeedDropBase {
  slug: string;
  name: string;
  chain: string;
  chainId: number | null;
  contractAddress: string;
  imageUrl: string | null;
  openSeaUrl: string;
  maxSupply: number | null;
  totalSupply: number | null;
}

export interface UpcomingDrop extends FeedDropBase {
  isMinting: boolean;
  stage: FeedStage | null;
}

export interface PastMint extends FeedDropBase {
  mintedAt: string;
  endsAt: string | null;
  status: 'minting' | 'ended' | 'sold_out';
  mintPrice: FeedPrice | null;
  floor: FeedPrice | null;
  owners: number | null;
  volume: FeedPrice | null;
  sales: number | null;
}

export interface DropsFeed {
  window: FeedWindow;
  upcoming: UpcomingDrop[];
  pastMints: PastMint[];
  fetchedAt: string;
  warning: string | null;
}

export const WINDOW_OPTIONS: readonly { value: FeedWindow; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

const SAVED_KEY = (window: FeedWindow) => `stryx-home-feed-v1:${window}`;

/** The last feed this browser loaded, so Home shows drops the moment it opens. */
export function savedFeed(window: FeedWindow): DropsFeed | undefined {
  try {
    const raw = localStorage.getItem(SAVED_KEY(window));
    if (!raw) return undefined;
    const feed = JSON.parse(raw) as DropsFeed;
    return typeof feed?.fetchedAt === 'string' && Array.isArray(feed.upcoming) && Array.isArray(feed.pastMints) ? feed : undefined;
  } catch {
    return undefined;
  }
}

function saveFeed(window: FeedWindow, feed: DropsFeed): void {
  try {
    localStorage.setItem(SAVED_KEY(window), JSON.stringify(feed));
  } catch {
    // Storage full or blocked: Home still works, it just waits for the server next time.
  }
}

/** The server caches for 10 minutes; asking more often than every 5 would only re-read its cache. */
export function useDropsFeed(window: FeedWindow) {
  return useQuery({
    queryKey: ['home-drops', window],
    queryFn: async () => {
      const feed = await apiRequest<DropsFeed>(`/home/drops?window=${window}`);
      saveFeed(window, feed);
      return feed;
    },
    initialData: () => savedFeed(window),
    initialDataUpdatedAt: () => {
      const saved = savedFeed(window);
      return saved ? Date.parse(saved.fetchedAt) : undefined;
    },
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    placeholderData: (previous) => previous,
  });
}

/** "Free", "0.002 ETH", or "-" when unknown. */
export function formatPrice(price: FeedPrice | null): string {
  if (!price) return '-';
  if (price.amount === '0') return 'Free';
  return price.symbol ? `${price.amount} ${price.symbol}` : price.amount;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function formatCount(n: number | null): string {
  if (n === null) return '-';
  return n >= 10_000 ? compact.format(n) : n.toLocaleString('en');
}

/** "3,333 / 3,333", "120 / 1,000", "1,000 max", or "-". */
export function formatSupply(totalSupply: number | null, maxSupply: number | null): string {
  if (totalSupply !== null && maxSupply !== null && maxSupply > 0) return `${formatCount(totalSupply)} / ${formatCount(maxSupply)}`;
  if (maxSupply !== null && maxSupply > 0) return `${formatCount(maxSupply)} max`;
  if (totalSupply !== null && totalSupply > 0) return `${formatCount(totalSupply)} minted`;
  return '-';
}

/** Percentage minted, for the supply bar. Null when there is no cap to measure against. */
export function mintedPercent(totalSupply: number | null, maxSupply: number | null): number | null {
  if (totalSupply === null || maxSupply === null || maxSupply <= 0) return null;
  return Math.max(0, Math.min(100, (totalSupply / maxSupply) * 100));
}

/**
 * Floor over mint price ("2.4x"), only when the two are in the same currency and the mint was not free
 * (a free mint has no meaningful multiple).
 */
export function floorMultiple(mint: FeedPrice | null, floor: FeedPrice | null): string | null {
  if (!mint || !floor || !mint.symbol || mint.symbol !== floor.symbol) return null;
  const m = Number(mint.amount);
  const f = Number(floor.amount);
  if (!(m > 0) || !(f > 0)) return null;
  const x = f / m;
  return `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}x`;
}

/** "in 3h 20m", "in 2d 4h", "now". For a start time in the future. */
export function startsIn(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '-';
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

/** "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Local date and time, short: "Sep 29, 14:00". */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** OpenSea's chain slug as a readable name when the platform does not know the chain ("bera_chain" -> "Bera chain"). */
export function chainLabel(chain: string): string {
  const s = chain.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const STATUS_LABEL: Record<PastMint['status'], string> = {
  minting: 'Minting',
  ended: 'Ended',
  sold_out: 'Sold out',
};
