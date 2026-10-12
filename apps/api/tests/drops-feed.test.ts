import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { DropsFeedService, type SnapshotStore } from '../src/drops-feed.service.js';
import { homeController } from '../src/home-controller.js';
import { registerResponseRedaction } from '../src/response-redaction.js';
import type { FetchLike } from '../src/opensea-resolver.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ZERO = '0x0000000000000000000000000000000000000000';

type Routes = Record<string, unknown>;

function fakeFetch(routes: Routes) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const path = url.replace('https://api.opensea.io', '');
    calls.push(path);
    const hit = Object.entries(routes).find(([p]) => path === p || path.startsWith(`${p}&`) || (p.endsWith('*') && path.startsWith(p.slice(0, -1))));
    if (!hit) return { ok: false, status: 404, json: async () => ({ errors: ['not found'] }) };
    const value = hit[1];
    if (value instanceof Error) throw value;
    return { ok: true, status: 200, json: async () => value };
  };
  return { fetchImpl, calls };
}

const stage = (over: Record<string, unknown>) => ({
  uuid: 'u',
  stage_type: 'public_sale',
  label: null,
  price: '0',
  price_currency_address: ZERO,
  start_time: iso(NOW - DAY),
  end_time: iso(NOW + DAY),
  max_per_wallet: '3',
  ...over,
});

const summary = (slug: string, chain: string, over: Record<string, unknown> = {}) => ({
  collection_slug: slug,
  collection_name: slug.toUpperCase(),
  chain,
  contract_address: '0xabc',
  drop_type: 'seadrop_v1_erc721',
  is_minting: false,
  image_url: 'https://i.seadn.io/x.png',
  opensea_url: `https://opensea.io/collection/${slug}`,
  active_stage: null,
  next_stage: null,
  ...over,
});

function routesFor(): Routes {
  return {
    '/api/v2/drops?type=upcoming': {
      drops: [
        summary('later', 'base', { next_stage: stage({ stage_type: 'presale', label: 'GTD', start_time: iso(NOW + 3 * DAY), price: '1000000000000000' }) }),
        summary('live', 'ethereum', { is_minting: true, active_stage: stage({ price: '4200000000000000' }) }),
        summary('sooner', 'unknownchain', { next_stage: stage({ start_time: iso(NOW + DAY) }) }),
      ],
      next: null,
    },
    '/api/v2/drops?type=recently_minted': {
      drops: [summary('fresh', 'ethereum'), summary('twoweeks', 'base'), summary('ancient', 'ethereum'), summary('broken', 'ethereum')],
      next: null,
    },
    '/api/v2/drops/later': { stages: [], total_supply: '0', max_supply: '5000' },
    '/api/v2/drops/live': { stages: [], total_supply: '120', max_supply: '1000' },
    '/api/v2/drops/sooner': { stages: [], total_supply: null, max_supply: null },
    '/api/v2/drops/fresh': {
      stages: [
        stage({ stage_type: 'presale', start_time: iso(NOW - 2 * DAY), end_time: iso(NOW - DAY), price: '0' }),
        stage({ start_time: iso(NOW - DAY), end_time: iso(NOW - DAY / 2), price: '2000000000000000' }),
      ],
      total_supply: '3333',
      max_supply: '3333',
    },
    '/api/v2/drops/twoweeks': { stages: [stage({ start_time: iso(NOW - 14 * DAY), end_time: iso(NOW - 13 * DAY), price: '0' })], total_supply: '10', max_supply: '100' },
    '/api/v2/drops/ancient': { stages: [stage({ start_time: iso(NOW - 60 * DAY), end_time: iso(NOW - 59 * DAY) })], total_supply: '1', max_supply: '1' },
    '/api/v2/collections/fresh/stats': { total: { floor_price: 0.0123456, floor_price_symbol: 'ETH', num_owners: 1500, volume: 12.5, volume_symbol: 'ETH', sales: 900 }, intervals: [] },
    '/api/v2/collections/twoweeks/stats': { total: { floor_price: 0, floor_price_symbol: '', num_owners: 7, volume: 0, volume_symbol: 'ETH', sales: 0 }, intervals: [] },
  };
}

function service(routes: Routes = routesFor(), now = { t: NOW }, store?: SnapshotStore) {
  const { fetchImpl, calls } = fakeFetch(routes);
  const svc = new DropsFeedService(fetchImpl, 'test-key', { now: () => now.t, ...(store ? { store } : {}) });
  return { svc, calls, now };
}

/** Lets a background rebuild finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStore() {
  const box: { value: string | null; saves: number } = { value: null, saves: 0 };
  const store: SnapshotStore = {
    load: async () => box.value,
    save: async (v) => {
      box.value = v;
      box.saves++;
    },
  };
  return { store, box };
}

describe('DropsFeedService', () => {
  it('lists live drops first, then upcoming by start time, with supply and a formatted price', async () => {
    const { svc } = service();
    const feed = await svc.getFeed('7d');
    expect(feed.upcoming.map((d) => d.slug)).toEqual(['live', 'sooner', 'later']);
    const live = feed.upcoming[0]!;
    expect(live).toMatchObject({ isMinting: true, chainId: 1, maxSupply: 1000, totalSupply: 120 });
    expect(live.stage?.price).toEqual({ amount: '0.0042', symbol: 'ETH' });
    expect(live.stage?.label).toBe('Public');
    expect(feed.upcoming[2]!.stage).toMatchObject({ label: 'GTD', price: { amount: '0.001', symbol: 'ETH' } });
    // A chain this platform does not run still shows, just without a chain id or symbol.
    expect(feed.upcoming[1]).toMatchObject({ chain: 'unknownchain', chainId: null });
  });

  it('keeps past mints inside the window, newest first, with floor and sold-out status', async () => {
    const { svc } = service();
    const week = await svc.getFeed('7d');
    expect(week.pastMints.map((m) => m.slug)).toEqual(['fresh']);
    expect(week.pastMints[0]).toMatchObject({
      status: 'sold_out',
      mintedAt: iso(NOW - 2 * DAY),
      mintPrice: { amount: '0.002', symbol: 'ETH' },
      floor: { amount: '0.0123', symbol: 'ETH' },
      owners: 1500,
      sales: 900,
    });

    const month = await svc.getFeed('30d');
    expect(month.pastMints.map((m) => m.slug)).toEqual(['fresh', 'twoweeks']);
    // OpenSea reports floor 0 when nothing is listed: that is "no floor", not a free floor.
    expect(month.pastMints[1]).toMatchObject({ status: 'ended', floor: null, mintPrice: { amount: '0', symbol: 'ETH' } });
  });

  it('builds once for both windows, and not again until the snapshot expires', async () => {
    const { svc, calls, now } = service();
    await svc.getFeed('7d');
    const first = calls.length;
    await svc.getFeed('30d');
    await svc.getFeed('7d');
    expect(calls.length).toBe(first);

    now.t += 11 * 60_000; // past the 10-minute snapshot
    await svc.getFeed('7d');
    const lists = calls.slice(first).filter((c) => c.startsWith('/api/v2/drops?'));
    expect(lists).toHaveLength(2);
    // Drop details are cached for 30 minutes, so the rebuild re-reads only the lists and expired stats.
    expect(calls.slice(first).some((c) => c === '/api/v2/drops/fresh')).toBe(false);
  });

  it('shares one build between concurrent requests', async () => {
    const { svc, calls } = service();
    await Promise.all([svc.getFeed('7d'), svc.getFeed('30d'), svc.getFeed('7d')]);
    expect(calls.filter((c) => c.startsWith('/api/v2/drops?type=upcoming'))).toHaveLength(1);
  });

  it('never fetches stats for drops outside the 30-day window', async () => {
    const { svc, calls } = service();
    await svc.getFeed('30d');
    expect(calls).not.toContain('/api/v2/collections/ancient/stats');
  });

  it('serves the last snapshot with a warning when OpenSea goes down', async () => {
    const routes = routesFor();
    const { svc, now } = service(routes);
    await svc.getFeed('7d');
    routes['/api/v2/drops?type=upcoming'] = new TypeError('fetch failed');
    routes['/api/v2/drops?type=recently_minted'] = new TypeError('fetch failed');
    now.t += 11 * 60_000;
    // Answered at once from the old snapshot while the refresh runs (and fails, after one retry) behind it...
    expect((await svc.getFeed('7d')).upcoming).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // ...and from then on it says the data is not fresh.
    const feed = await svc.getFeed('7d');
    expect(feed.upcoming).toHaveLength(3);
    expect(feed.warning).toMatch(/last loaded/);
  });

  it('serves an expired snapshot at once and refreshes it behind the answer', async () => {
    const { svc, now } = service();
    const first = await svc.getFeed('7d');
    now.t += 11 * 60_000;
    const stale = await svc.getFeed('7d');
    expect(stale.fetchedAt).toBe(first.fetchedAt); // no waiting for OpenSea
    await settle();
    expect(Date.parse((await svc.getFeed('7d')).fetchedAt)).toBe(now.t);
  });

  it('waits for a rebuild when the only snapshot is more than a day old', async () => {
    const { svc, now } = service();
    await svc.getFeed('7d');
    now.t += 25 * 60 * 60_000;
    expect(Date.parse((await svc.getFeed('7d')).fetchedAt)).toBe(now.t);
  });

  it('keeps the snapshot in a store, so a restarted API answers without calling OpenSea', async () => {
    const { store, box } = memoryStore();
    const before = service(routesFor(), { t: NOW }, store);
    await before.svc.getFeed('30d');
    await settle();
    expect(box.saves).toBe(1);
    const after = service(routesFor(), { t: NOW + 60_000 }, store); // a new process, a minute later
    const feed = await after.svc.getFeed('30d');
    expect(feed.upcoming).toHaveLength(3);
    expect(after.calls).toHaveLength(0);
  });

  it('warm builds in the background when nothing is saved, and not when a fresh snapshot is', async () => {
    const { store } = memoryStore();
    const cold = service(routesFor(), { t: NOW }, store);
    await cold.svc.warm();
    await settle();
    await settle();
    expect(cold.calls.some((c) => c.startsWith('/api/v2/drops?type=upcoming'))).toBe(true);
    const restarted = service(routesFor(), { t: NOW + 60_000 }, store);
    await restarted.svc.warm();
    expect(restarted.calls).toHaveLength(0);
  });

  it('still returns past mints when only the upcoming list fails', async () => {
    const routes = routesFor();
    delete routes['/api/v2/drops?type=upcoming'];
    const { svc } = service(routes);
    const feed = await svc.getFeed('7d');
    expect(feed.upcoming).toEqual([]);
    expect(feed.pastMints).toHaveLength(1);
    expect(feed.warning).toMatch(/Upcoming/);
  });

  it('keeps the last good list when one list fails on a rebuild', async () => {
    const routes = routesFor();
    const { svc, now } = service(routes);
    await svc.getFeed('7d');
    routes['/api/v2/drops?type=upcoming'] = { drops: [], next: null };
    delete routes['/api/v2/drops?type=recently_minted'];
    now.t += 25 * 60 * 60_000;
    const feed = await svc.getFeed('7d');
    expect(feed.upcoming).toEqual([]);
    expect(feed.pastMints.map((m) => m.slug)).toEqual(['fresh']);
    expect(feed.warning).toMatch(/Past mints could not be refreshed/);
  });

  it('refuses a non-OpenSea link and a non-https image', async () => {
    const routes = routesFor();
    routes['/api/v2/drops?type=upcoming'] = {
      drops: [summary('sketchy', 'ethereum', { opensea_url: 'https://evil.example/x', image_url: 'javascript:alert(1)', next_stage: stage({ start_time: iso(NOW + DAY) }) })],
      next: null,
    };
    routes['/api/v2/drops/sketchy'] = { stages: [] };
    const { svc } = service(routes);
    const [drop] = (await svc.getFeed('7d')).upcoming;
    expect(drop!.openSeaUrl).toBe('https://opensea.io/collection/sketchy');
    expect(drop!.imageUrl).toBeNull();
  });
});

describe('GET /home/drops', () => {
  async function build(svc: DropsFeedService) {
    const app = Fastify();
    const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
    registerResponseRedaction(app, log);
    await app.register(homeController({ dropsFeedService: svc, logger: log }));
    return app;
  }

  it('defaults to the 7-day window', async () => {
    const app = await build(service().svc);
    const res = await app.inject({ method: 'GET', url: '/home/drops' });
    expect(res.statusCode).toBe(200);
    expect(res.json().window).toBe('7d');
  });

  it('accepts 30d and rejects anything else', async () => {
    const app = await build(service().svc);
    expect((await app.inject({ method: 'GET', url: '/home/drops?window=30d' })).json().window).toBe('30d');
    expect((await app.inject({ method: 'GET', url: '/home/drops?window=90d' })).statusCode).toBe(400);
  });

  it('says plainly when no OpenSea key is configured', async () => {
    const app = await build(new DropsFeedService(fakeFetch({}).fetchImpl, undefined));
    const res = await app.inject({ method: 'GET', url: '/home/drops' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('feed_not_configured');
  });

  it('returns 502 when OpenSea cannot be read and nothing is cached', async () => {
    const app = await build(new DropsFeedService(fakeFetch({}).fetchImpl, 'k'));
    const res = await app.inject({ method: 'GET', url: '/home/drops' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('feed_unavailable');
  });
});
