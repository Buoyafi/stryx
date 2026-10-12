import { describe, expect, it, vi } from 'vitest';
import { dropCardMarkup, escapeHtml, formatPrice, hashName, mountDropsStrip, opensIn, safeImageUrl, stripMarkup, toStripDrops, updatedAgo } from '../src/lib/drops-strip.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const at = (mins) => new Date(NOW + mins * 60_000).toISOString();
const base = { chain: 'base', chainId: 8453, imageUrl: null, contractAddress: '0x1', openSeaUrl: 'https://opensea.io/x', maxSupply: null, totalSupply: null };
const upcoming = (name, startMins, extra = {}) => ({ ...base, slug: name, name, isMinting: false, stage: { label: 'Public', stageType: 'public', startTime: at(startMins), endTime: at(startMins + 60), price: { amount: '0.002', symbol: 'ETH' }, maxPerWallet: 1 }, ...extra });
const past = (name, status, extra = {}) => ({ ...base, slug: name, name, mintedAt: at(-60), endsAt: null, status, mintPrice: { amount: '0', symbol: 'ETH' }, floor: null, owners: null, volume: null, sales: null, ...extra });

describe('opensIn', () => {
  it('reads minutes, then hours and minutes, then days', () => {
    expect(opensIn(at(38), NOW)).toBe('Opens in 38m');
    expect(opensIn(at(134), NOW)).toBe('Opens in 2h 14m');
    expect(opensIn(at(24 * 60 + 5), NOW)).toBe('Opens tomorrow');
    expect(opensIn(at(4 * 24 * 60), NOW)).toBe('Opens in 4d');
  });
  it('says so when the start has passed or cannot be read', () => {
    expect(opensIn(at(-5), NOW)).toBe('Opening now');
    expect(opensIn('nonsense', NOW)).toBe('Upcoming');
  });
});

describe('formatPrice', () => {
  it('formats amounts, calls zero Free, and says nothing when there is no price', () => {
    expect(formatPrice({ amount: '0.0042', symbol: 'ETH' })).toBe('0.0042 ETH');
    expect(formatPrice({ amount: '12', symbol: '' })).toBe('12');
    expect(formatPrice({ amount: '0', symbol: 'ETH' })).toBe('Free');
    expect(formatPrice(null)).toBe('');
  });
});

describe('safeImageUrl', () => {
  it('allows https only', () => {
    expect(safeImageUrl('https://i.seadn.io/a.png')).toBe('https://i.seadn.io/a.png');
    for (const bad of ['http://x.io/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//x.io/a.png', '', null, undefined]) expect(safeImageUrl(bad)).toBeNull();
  });
});

describe('toStripDrops', () => {
  const feed = { upcoming: [upcoming('Later', 300), upcoming('Live', -10, { isMinting: true }), upcoming('Soon', 40)], pastMints: [past('Gone', 'sold_out'), past('Done', 'ended'), past('Still', 'minting')] };

  it('puts drops minting now first, then the soonest to open, then recent past mints', () => {
    expect(toStripDrops(feed, { now: NOW }).map((d) => d.name)).toEqual(['Live', 'Soon', 'Later', 'Gone', 'Done', 'Still']);
  });

  it('labels each card from its state, and only live ones are marked live', () => {
    const cards = Object.fromEntries(toStripDrops(feed, { now: NOW }).map((d) => [d.name, d]));
    expect(cards.Live).toMatchObject({ tag: 'Minting now', live: true });
    expect(cards.Soon).toMatchObject({ tag: 'Opens in 40m', live: false, price: '0.002 ETH' });
    expect(cards.Gone).toMatchObject({ tag: 'Sold out', live: false, price: 'Free' });
    expect(cards.Done.tag).toBe('Ended');
    expect(cards.Still).toMatchObject({ tag: 'Minting now', live: true });
  });

  it('names the chain from the registry, or tidies OpenSea\'s name for one it does not know', () => {
    const [known, unknown] = toStripDrops({ upcoming: [upcoming('A', 10), upcoming('B', 20, { chainId: null, chain: 'some-new_chain' })], pastMints: [] }, { now: NOW });
    expect(known.chain).toBe('Base');
    expect(unknown.chain).toBe('Some New Chain');
  });

  it('respects the limit and survives an empty or malformed feed', () => {
    expect(toStripDrops(feed, { now: NOW, limit: 2 })).toHaveLength(2);
    expect(toStripDrops({}, { now: NOW })).toEqual([]);
    expect(toStripDrops(null, { now: NOW })).toEqual([]);
  });

  it('drops an image that is not https', () => {
    const [d] = toStripDrops({ upcoming: [upcoming('X', 5, { imageUrl: 'http://evil.example/a.png' })], pastMints: [] }, { now: NOW });
    expect(d.imageUrl).toBeNull();
  });
});

describe('dropCardMarkup', () => {
  const card = { name: 'Slow Signal', chain: 'Base', price: '0.002 ETH', tag: 'Minting now', live: true, imageUrl: null };

  it('escapes everything that came from the feed', () => {
    const html = dropCardMarkup({ ...card, name: '<img src=x onerror=alert(1)>', chain: '"><script>', price: '<b>', tag: '&' });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('adds an <img> only when there is an image, with no referrer and lazy loading', () => {
    expect(dropCardMarkup(card)).not.toContain('<img');
    const html = dropCardMarkup({ ...card, imageUrl: 'https://i.seadn.io/a.png?w=1&h=2' });
    expect(html).toContain('<img src="https://i.seadn.io/a.png?w=1&amp;h=2"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
  });

  it('gives a drop the same generated art every time, and different drops different art', () => {
    expect(dropCardMarkup(card)).toBe(dropCardMarkup({ ...card }));
    expect(hashName('A')).not.toBe(hashName('B'));
    expect(dropCardMarkup(card)).toMatch(/--m1:\d+%;--m2:\d+%/);
  });

  it('keeps the art\'s numbers inside their ranges for any name (no negative offsets from a large hash)', () => {
    for (const name of ['', 'a', 'Slow Signal', 'Ferrous Kids', 'x'.repeat(200), '😀 Emoji Club', ...Array.from({ length: 300 }, (_, i) => `Drop ${i}`)]) {
      const html = dropCardMarkup({ ...card, name });
      const vars = Object.fromEntries([...html.matchAll(/--(\w+):(-?\d+)/g)].map((m) => [m[1], Number(m[2])]));
      for (const [key, value] of Object.entries(vars)) {
        expect(value, `${name} --${key}`).toBeGreaterThanOrEqual(0);
        expect(value, `${name} --${key}`).toBeLessThan(100);
      }
    }
  });

  it('marks the tag live only for live drops', () => {
    expect(dropCardMarkup(card)).toContain('class="tag live"');
    expect(dropCardMarkup({ ...card, live: false })).toContain('class="tag"');
  });
});

describe('stripMarkup', () => {
  it('repeats the list once for the seamless loop, hiding the copy from assistive tech', () => {
    const html = stripMarkup([{ name: 'A', chain: 'Base', price: '', tag: 'Ended', live: false, imageUrl: null }]);
    expect(html.match(/<ul class="mq-track"/g)).toHaveLength(2);
    expect(html).toContain('<ul class="mq-track" aria-hidden="true">');
  });
});

describe('updatedAgo / escapeHtml', () => {
  it('describes how old the snapshot is, and says nothing for a bad or future timestamp', () => {
    expect(updatedAgo(at(0), NOW)).toBe('Updated just now');
    expect(updatedAgo(at(-4), NOW)).toBe('Updated 4 min ago');
    expect(updatedAgo(at(-180), NOW)).toBe('Updated 3 h ago');
    expect(updatedAgo(at(5), NOW)).toBe('');
    expect(updatedAgo('x', NOW)).toBe('');
  });
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('mountDropsStrip', () => {
  const makeSection = () => {
    const section = { hidden: true, parts: { track: { innerHTML: '' }, note: { textContent: '' } } };
    section.querySelector = (sel) => (sel === '[data-drops-track]' ? section.parts.track : sel === '[data-drops-note]' ? section.parts.note : null);
    return section;
  };
  const feedOf = (n) => ({ fetchedAt: at(-2), upcoming: Array.from({ length: n }, (_, i) => upcoming(`Drop ${i}`, 10 + i)), pastMints: [] });
  const ok = (body) => vi.fn(async () => ({ ok: true, json: async () => body }));

  it('shows the section, with a freshness note, when the feed has enough drops', async () => {
    const section = makeSection();
    const fetchImpl = ok(feedOf(5));
    await mountDropsStrip(section, { fetchImpl, now: () => NOW, search: '' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/home/drops?window=7d', expect.anything());
    expect(section.hidden).toBe(false);
    expect(section.parts.track.innerHTML).toContain('Drop 0');
    expect(section.parts.note.textContent).toBe('Live from OpenSea · Updated 2 min ago');
  });

  it('stays hidden when there are too few drops, the feed errors, or the network fails', async () => {
    const cases = [ok(feedOf(2)), vi.fn(async () => ({ ok: false, json: async () => ({}) })), vi.fn(async () => { throw new Error('offline'); })];
    for (const fetchImpl of cases) {
      const section = makeSection();
      await mountDropsStrip(section, { fetchImpl, now: () => NOW, search: '' });
      expect(section.hidden).toBe(true);
      expect(section.parts.track.innerHTML).toBe('');
    }
  });

  it('never shows invented drops unless the preview flag is set', async () => {
    const off = makeSection();
    await mountDropsStrip(off, { fetchImpl: vi.fn(async () => { throw new Error('x'); }), now: () => NOW, search: '' });
    expect(off.hidden).toBe(true);
    const on = makeSection();
    const fetchImpl = vi.fn();
    await mountDropsStrip(on, { fetchImpl, now: () => NOW, search: '?sample=1' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(on.hidden).toBe(false);
    expect(on.parts.note.textContent).toMatch(/Sample drops/);
  });
});
