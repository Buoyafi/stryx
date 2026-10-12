import { formatUnits } from 'viem';
import { withRetry, isFetchTransportFailure } from '@stryx/utils';
import type { FetchLike } from './opensea-resolver.js';
import { chainById, openSeaChainNameToId } from './chain-registry.js';

/**
 * The Home page feed: OpenSea's upcoming drops and the drops that minted in the last 7 or 30 days,
 * with supply and floor price.
 */

export type FeedWindow = '7d' | '30d';

export interface FeedPrice {
  /** Human amount, e.g. "0.0042". "0" means a free mint. */
  amount: string;
  /** Native symbol when known (ETH, POL, ...); empty when the currency is not the chain's native token. */
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

export interface FeedDropBase {
  slug: string;
  name: string;
  /** OpenSea's chain name (e.g. "ethereum", "base"). */
  chain: string;
  /** Numeric chain id when this platform knows the chain; null otherwise. */
  chainId: number | null;
  contractAddress: string;
  imageUrl: string | null;
  openSeaUrl: string;
  maxSupply: number | null;
  totalSupply: number | null;
}

export interface UpcomingDrop extends FeedDropBase {
  /** True when a stage is live right now. */
  isMinting: boolean;
  /** The live stage, else the next one to open. */
  stage: FeedStage | null;
}

export interface PastMint extends FeedDropBase {
  /** When minting started (earliest stage start). */
  mintedAt: string;
  /** When the last stage ends or ended. */
  endsAt: string | null;
  status: 'minting' | 'ended' | 'sold_out';
  /** Public-stage price when there is one, else the lowest stage price. */
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
  /** When the underlying snapshot was built (ISO). */
  fetchedAt: string;
  /** Set when OpenSea could not be read; the lists may then be empty or older than fetchedAt suggests. */
  warning: string | null;
}

export class DropsFeedError extends Error {
  constructor(
    public readonly code: 'no_api_key' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'DropsFeedError';
  }
}

interface Options {
  apiBase?: string;
  now?: () => number;
  snapshotTtlMs?: number;
  detailTtlMs?: number;
  statsTtlMs?: number;
  /** Pages of 100 read from each list. */
  maxPages?: number;
  /** Most drops enriched per list per build. */
  maxEnriched?: number;
  concurrency?: number;
  /** An expired snapshot younger than this is served at once while a new one builds. Default 24 hours. */
  maxStaleMs?: number;
  /** Where the snapshot is kept across restarts (Redis in the API). */
  store?: SnapshotStore;
}

/** Keeps the last snapshot outside this process. Failures are ignored: it only saves a wait. */
export interface SnapshotStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}

interface Snapshot {
  builtAt: number;
  upcoming: UpcomingDrop[];
  /** Everything minted in the last 30 days, newest first. */
  pastMints: PastMint[];
  warning: string | null;
}

interface RawStage {
  uuid?: unknown;
  stage_type?: unknown;
  label?: unknown;
  price?: unknown;
  price_currency_address?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  max_per_wallet?: unknown;
}

interface RawDrop {
  collection_slug?: unknown;
  collection_name?: unknown;
  chain?: unknown;
  contract_address?: unknown;
  is_minting?: unknown;
  image_url?: unknown;
  opensea_url?: unknown;
  active_stage?: RawStage | null;
  next_stage?: RawStage | null;
  stages?: unknown;
  total_supply?: unknown;
  max_supply?: unknown;
}

interface DropDetail {
  stages: RawStage[];
  totalSupply: number | null;
  maxSupply: number | null;
}

interface CollectionStats {
  floor: FeedPrice | null;
  owners: number | null;
  volume: FeedPrice | null;
  sales: number | null;
}

const DAY_MS = 86_400_000;
const WINDOW_MS: Record<FeedWindow, number> = { '7d': 7 * DAY_MS, '30d': 30 * DAY_MS };
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const STALE_WARNING = 'OpenSea could not be reached; showing the last loaded data.';

export class DropsFeedService {
  private readonly apiBase: string;
  private readonly now: () => number;
  private readonly snapshotTtlMs: number;
  private readonly detailTtlMs: number;
  private readonly statsTtlMs: number;
  private readonly maxPages: number;
  private readonly maxEnriched: number;
  private readonly concurrency: number;
  private readonly maxStaleMs: number;
  private readonly store: SnapshotStore | undefined;
  private storeChecked = false;
  /** Set when the last rebuild failed, so the old snapshot is served with a warning. */
  private lastBuildFailed = false;

  private snapshot: Snapshot | null = null;
  private building: Promise<Snapshot> | null = null;
  private readonly detailCache = new Map<string, { at: number; value: DropDetail | null }>();
  private readonly statsCache = new Map<string, { at: number; value: CollectionStats | null }>();

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly apiKey: string | undefined,
    options: Options = {},
  ) {
    this.apiBase = options.apiBase ?? 'https://api.opensea.io';
    this.now = options.now ?? Date.now;
    this.snapshotTtlMs = options.snapshotTtlMs ?? 10 * 60_000;
    this.detailTtlMs = options.detailTtlMs ?? 30 * 60_000;
    this.statsTtlMs = options.statsTtlMs ?? 15 * 60_000;
    this.maxPages = options.maxPages ?? 2;
    this.maxEnriched = options.maxEnriched ?? 100;
    this.concurrency = options.concurrency ?? 3;
    this.maxStaleMs = options.maxStaleMs ?? 24 * 60 * 60_000;
    this.store = options.store;
  }

  /**
   * Called once at startup: picks up the saved snapshot, and builds a new one in the background if
   * there is none or it has expired.
   */
  async warm(): Promise<void> {
    if (!this.apiKey) return;
    await this.loadSaved();
    if (!this.snapshot || this.now() - this.snapshot.builtAt >= this.snapshotTtlMs) void this.rebuild().catch(() => undefined);
  }

  async getFeed(window: FeedWindow): Promise<DropsFeed> {
    if (!this.apiKey) throw new DropsFeedError('no_api_key', 'The Home page feed needs OPENSEA_API_KEY.');
    const snap = await this.currentSnapshot();
    const cutoff = this.now() - WINDOW_MS[window];
    return {
      window,
      upcoming: snap.upcoming,
      pastMints: snap.pastMints.filter((m) => Date.parse(m.mintedAt) >= cutoff),
      fetchedAt: new Date(snap.builtAt).toISOString(),
      warning: snap.warning,
    };
  }

  private async currentSnapshot(): Promise<Snapshot> {
    await this.loadSaved();
    const age = this.snapshot ? this.now() - this.snapshot.builtAt : Infinity;
    if (age < this.snapshotTtlMs) return this.snapshot!;
    // Expired but recent enough: answer now, refresh behind it. The next request gets the new one.
    if (age < this.maxStaleMs) {
      void this.rebuild().catch(() => undefined);
      return this.lastBuildFailed ? { ...this.snapshot!, warning: STALE_WARNING } : this.snapshot!;
    }
    try {
      return await this.rebuild();
    } catch (err) {
      // OpenSea unreachable: an older snapshot beats an error page.
      if (this.snapshot) return { ...this.snapshot, warning: STALE_WARNING };
      throw err;
    }
  }

  /** One build at a time; a finished one becomes the snapshot and is saved. */
  private rebuild(): Promise<Snapshot> {
    if (!this.building) {
      this.building = this.build()
        .then((snap) => {
          this.snapshot = snap;
          this.lastBuildFailed = false;
          void this.store?.save(JSON.stringify(snap)).catch(() => undefined);
          return snap;
        })
        .catch((err: unknown) => {
          this.lastBuildFailed = true;
          throw err;
        })
        .finally(() => {
          this.building = null;
        });
    }
    return this.building;
  }

  /** Once per process: the snapshot saved by an earlier run, if it is newer than what we hold. */
  private async loadSaved(): Promise<void> {
    if (this.storeChecked || !this.store) return;
    this.storeChecked = true;
    try {
      const raw = await this.store.load();
      if (!raw) return;
      const saved = JSON.parse(raw) as Snapshot;
      if (typeof saved?.builtAt === 'number' && Array.isArray(saved.upcoming) && Array.isArray(saved.pastMints) && (!this.snapshot || saved.builtAt > this.snapshot.builtAt)) {
        this.snapshot = saved;
      }
    } catch {
      // A missing or unreadable saved copy only means the first request builds one.
    }
  }

  private async build(): Promise<Snapshot> {
    const [upcomingRes, recentRes] = await Promise.allSettled([this.listDrops('upcoming'), this.listDrops('recently_minted')]);
    if (upcomingRes.status === 'rejected' && recentRes.status === 'rejected') {
      throw new DropsFeedError('unavailable', 'Could not read drops from OpenSea. Try again in a moment.');
    }
    const warning =
      upcomingRes.status === 'rejected' ? 'Upcoming drops could not be loaded from OpenSea.' : recentRes.status === 'rejected' ? 'Past mints could not be loaded from OpenSea.' : null;

    const now = this.now();
    const upcomingRaw = upcomingRes.status === 'fulfilled' ? upcomingRes.value.slice(0, this.maxEnriched) : [];
    const recentRaw = recentRes.status === 'fulfilled' ? recentRes.value.slice(0, this.maxEnriched) : [];

    const upcoming = (
      await mapLimit(upcomingRaw, this.concurrency, async (raw) => {
        const base = toBase(raw);
        if (!base) return null;
        const detail = await this.detail(base.slug);
        const stage = raw.active_stage ?? raw.next_stage ?? nextStageFrom(detail?.stages ?? [], now);
        const drop: UpcomingDrop = {
          ...base,
          maxSupply: detail?.maxSupply ?? null,
          totalSupply: detail?.totalSupply ?? null,
          isMinting: raw.is_minting === true,
          stage: stage ? toStage(stage, base.chain) : null,
        };
        return drop;
      })
    ).filter((d): d is UpcomingDrop => d !== null);
    upcoming.sort((a, b) => Number(b.isMinting) - Number(a.isMinting) || stageStart(a) - stageStart(b));

    const cutoff = now - WINDOW_MS['30d'];
    const pastMints = (
      await mapLimit(recentRaw, this.concurrency, async (raw) => {
        const base = toBase(raw);
        if (!base) return null;
        const detail = await this.detail(base.slug);
        const stages = detail?.stages ?? [];
        const starts = stages.map((s) => Date.parse(String(s.start_time))).filter(Number.isFinite);
        if (starts.length === 0) return null;
        const mintedAtMs = Math.min(...starts);
        // Only what actually started minting inside the widest window.
        if (mintedAtMs > now || mintedAtMs < cutoff) return null;
        const ends = stages.map((s) => Date.parse(String(s.end_time))).filter(Number.isFinite);
        const endsAtMs = ends.length > 0 ? Math.max(...ends) : null;
        const stats = await this.stats(base.slug);
        const soldOut = detail?.maxSupply != null && detail.totalSupply != null && detail.maxSupply > 0 && detail.totalSupply >= detail.maxSupply;
        const mint: PastMint = {
          ...base,
          maxSupply: detail?.maxSupply ?? null,
          totalSupply: detail?.totalSupply ?? null,
          mintedAt: new Date(mintedAtMs).toISOString(),
          endsAt: endsAtMs !== null ? new Date(endsAtMs).toISOString() : null,
          status: soldOut ? 'sold_out' : raw.is_minting === true || (endsAtMs !== null && endsAtMs > now) ? 'minting' : 'ended',
          mintPrice: mintPriceFrom(stages, base.chain),
          floor: stats?.floor ?? null,
          owners: stats?.owners ?? null,
          volume: stats?.volume ?? null,
          sales: stats?.sales ?? null,
        };
        return mint;
      })
    ).filter((m): m is PastMint => m !== null);
    pastMints.sort((a, b) => Date.parse(b.mintedAt) - Date.parse(a.mintedAt));

    // One list failed: keep the last good copy of it rather than replace it with nothing.
    const previous = this.snapshot;
    if (previous && upcomingRes.status === 'rejected') {
      return { builtAt: now, upcoming: previous.upcoming, pastMints, warning: 'Upcoming drops could not be refreshed from OpenSea. Showing the last list.' };
    }
    if (previous && recentRes.status === 'rejected') {
      return { builtAt: now, upcoming, pastMints: previous.pastMints, warning: 'Past mints could not be refreshed from OpenSea. Showing the last list.' };
    }
    return { builtAt: now, upcoming, pastMints, warning };
  }

  private async listDrops(type: 'upcoming' | 'recently_minted'): Promise<RawDrop[]> {
    const drops: RawDrop[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const query = new URLSearchParams({ type, limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const body = await this.getJson(`/api/v2/drops?${query.toString()}`);
      if (body === null) throw new DropsFeedError('unavailable', `OpenSea drops list (${type}) was not readable.`);
      const b = body as { drops?: unknown; next?: unknown };
      if (Array.isArray(b.drops)) drops.push(...(b.drops as RawDrop[]));
      cursor = typeof b.next === 'string' && b.next.length > 0 ? b.next : null;
      if (!cursor) break;
    }
    // A drop can appear on two pages if OpenSea's list shifts between reads.
    const seen = new Set<string>();
    return drops.filter((d) => {
      const slug = typeof d.collection_slug === 'string' ? d.collection_slug : '';
      if (!slug || seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  }

  private async detail(slug: string): Promise<DropDetail | null> {
    const cached = this.detailCache.get(slug);
    if (cached && this.now() - cached.at < this.detailTtlMs) return cached.value;
    const body = (await this.getJson(`/api/v2/drops/${encodeURIComponent(slug)}`).catch(() => null)) as RawDrop | null;
    const value: DropDetail | null = body
      ? {
          stages: Array.isArray(body.stages) ? (body.stages as RawStage[]) : [],
          totalSupply: toInt(body.total_supply),
          maxSupply: toInt(body.max_supply),
        }
      : null;
    // A failed read is cached too, briefly (same TTL), so one broken slug is not retried on every page view.
    this.detailCache.set(slug, { at: this.now(), value });
    return value;
  }

  private async stats(slug: string): Promise<CollectionStats | null> {
    const cached = this.statsCache.get(slug);
    if (cached && this.now() - cached.at < this.statsTtlMs) return cached.value;
    const body = (await this.getJson(`/api/v2/collections/${encodeURIComponent(slug)}/stats`).catch(() => null)) as {
      total?: Record<string, unknown>;
    } | null;
    const total = body?.total;
    const value: CollectionStats | null = total
      ? {
          floor: toStatPrice(total['floor_price'], total['floor_price_symbol'], true),
          owners: typeof total['num_owners'] === 'number' ? total['num_owners'] : null,
          volume: toStatPrice(total['volume'], total['volume_symbol'], false),
          sales: typeof total['sales'] === 'number' ? total['sales'] : null,
        }
      : null;
    this.statsCache.set(slug, { at: this.now(), value });
    return value;
  }

  /** GET with one retry on a transport failure. Null for a non-2xx response. */
  private async getJson(path: string): Promise<unknown> {
    const res = await withRetry(
      () => this.fetchImpl(`${this.apiBase}${path}`, { method: 'GET', headers: { accept: 'application/json', 'x-api-key': this.apiKey! } }),
      { attempts: 2, delayMs: 300, isRetryable: isFetchTransportFailure },
    );
    if (!res.ok) return null;
    return res.json();
  }
}

function toBase(raw: RawDrop): FeedDropBase | null {
  const slug = typeof raw.collection_slug === 'string' ? raw.collection_slug : null;
  const chain = typeof raw.chain === 'string' ? raw.chain : null;
  if (!slug || !chain) return null;
  return {
    slug,
    name: typeof raw.collection_name === 'string' && raw.collection_name.trim() ? raw.collection_name : slug,
    chain,
    chainId: openSeaChainNameToId(chain),
    contractAddress: typeof raw.contract_address === 'string' ? raw.contract_address : '',
    imageUrl: typeof raw.image_url === 'string' && /^https:\/\//i.test(raw.image_url) ? raw.image_url : null,
    openSeaUrl: typeof raw.opensea_url === 'string' && /^https:\/\/(www\.)?opensea\.io\//i.test(raw.opensea_url) ? raw.opensea_url : `https://opensea.io/collection/${encodeURIComponent(slug)}`,
    maxSupply: null,
    totalSupply: null,
  };
}

function toStage(raw: RawStage, chain: string): FeedStage {
  return {
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : humanStageType(String(raw.stage_type ?? '')),
    stageType: String(raw.stage_type ?? ''),
    startTime: String(raw.start_time ?? ''),
    endTime: String(raw.end_time ?? ''),
    price: toStagePrice(raw, chain),
    maxPerWallet: toInt(raw.max_per_wallet),
  };
}

function nextStageFrom(stages: RawStage[], now: number): RawStage | null {
  const live = stages.find((s) => Date.parse(String(s.start_time)) <= now && Date.parse(String(s.end_time)) > now);
  if (live) return live;
  const future = stages.filter((s) => Date.parse(String(s.start_time)) > now).sort((a, b) => Date.parse(String(a.start_time)) - Date.parse(String(b.start_time)));
  return future[0] ?? null;
}

function stageStart(d: UpcomingDrop): number {
  const t = d.stage ? Date.parse(d.stage.startTime) : NaN;
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

function mintPriceFrom(stages: RawStage[], chain: string): FeedPrice | null {
  const pub = stages.find((s) => s.stage_type === 'public_sale' && typeof s.price === 'string');
  if (pub) return toStagePrice(pub, chain);
  const priced = stages
    .filter((s) => typeof s.price === 'string' && /^\d+$/.test(s.price))
    .sort((a, b) => (BigInt(a.price as string) < BigInt(b.price as string) ? -1 : 1));
  return priced[0] ? toStagePrice(priced[0], chain) : null;
}

/** Stage prices are wei strings. Only the chain's native token is formatted with its known decimals. */
function toStagePrice(raw: RawStage, chain: string): FeedPrice | null {
  if (typeof raw.price !== 'string' || !/^\d+$/.test(raw.price)) return null;
  const currency = typeof raw.price_currency_address === 'string' ? raw.price_currency_address.toLowerCase() : ZERO_ADDRESS;
  if (currency !== ZERO_ADDRESS) return raw.price === '0' ? { amount: '0', symbol: '' } : null;
  const known = chainById(openSeaChainNameToId(chain) ?? -1);
  const decimals = known?.nativeCurrency.decimals ?? 18;
  return { amount: trimAmount(formatUnits(BigInt(raw.price), decimals)), symbol: known?.nativeCurrency.symbol ?? '' };
}

function toStatPrice(value: unknown, symbol: unknown, zeroIsNone: boolean): FeedPrice | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (zeroIsNone && value === 0) return null; // OpenSea reports 0 when nothing is listed
  return { amount: trimAmount(value.toFixed(10)), symbol: typeof symbol === 'string' ? symbol : '' };
}

/** Up to 4 decimals, but always 3 significant digits for a sub-unit amount (0.000042 stays readable). */
function trimAmount(amount: string): string {
  if (!amount.includes('.')) return amount;
  const [whole, frac = ''] = amount.split('.');
  const firstNonZero = frac.search(/[1-9]/);
  const keep = whole === '0' && firstNonZero >= 0 ? Math.max(4, firstNonZero + 3) : 4;
  const cut = frac.slice(0, keep).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole!;
}

function toInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

function humanStageType(stageType: string): string {
  if (stageType === 'public_sale') return 'Public';
  if (!stageType) return 'Stage';
  return stageType.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}
