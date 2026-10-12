import { CHAINS } from '@stryx/chains';

/**
 * The "Live from the feed" strip: upcoming and recent drops from the same public feed the app's Home
 * page reads. Hidden when the feed has too few drops or cannot be reached.
 */

const MIN_TO_SHOW = 4;
const SAMPLE_PARAM = 'sample';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

/** Only https image URLs are ever put in the page; anything else falls back to the generated art. */
export function safeImageUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** "Free", "0.002 ETH", or '' when the feed has no price. */
export function formatPrice(price) {
  if (!price || price.amount == null || price.amount === '') return '';
  if (Number(price.amount) === 0) return 'Free';
  return `${price.amount} ${price.symbol ?? ''}`.trim();
}

/** "Opens in 38m", "Opens in 2h 14m", "Opens tomorrow", "Opens in 4d". */
export function opensIn(startIso, nowMs) {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return 'Upcoming';
  const mins = Math.round((start - nowMs) / 60_000);
  if (mins <= 0) return 'Opening now';
  if (mins < 60) return `Opens in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Opens in ${hours}h ${String(mins % 60).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Opens tomorrow' : `Opens in ${days}d`;
}

const titleCase = (s) => String(s || '').replace(/(^|[-_ ])(\w)/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase());

function chainName(drop) {
  const known = drop.chainId == null ? null : CHAINS.find((c) => c.chainId === drop.chainId);
  return known?.name ?? titleCase(drop.chain);
}

/**
 * The feed (GET /home/drops) as card data: drops minting now first, then the soonest to open, then the
 * most recent past mints to fill the row.
 */
export function toStripDrops(feed, { limit = 12, now = Date.now() } = {}) {
  const upcoming = Array.isArray(feed?.upcoming) ? feed.upcoming : [];
  const past = Array.isArray(feed?.pastMints) ? feed.pastMints : [];
  const startOf = (d) => Date.parse(d.stage?.startTime ?? '') || Infinity;
  const cards = [
    ...upcoming.filter((d) => d.isMinting).map((d) => ({ d, tag: 'Minting now', live: true })),
    ...upcoming.filter((d) => !d.isMinting).sort((a, b) => startOf(a) - startOf(b)).map((d) => ({ d, tag: opensIn(d.stage?.startTime, now), live: false })),
    ...past.map((d) => ({ d, tag: d.status === 'sold_out' ? 'Sold out' : d.status === 'minting' ? 'Minting now' : 'Ended', live: d.status === 'minting' })),
  ];
  return cards.slice(0, limit).map(({ d, tag, live }) => ({
    name: d.name,
    chain: chainName(d),
    price: formatPrice(d.stage?.price ?? d.mintPrice),
    tag,
    live,
    imageUrl: safeImageUrl(d.imageUrl),
  }));
}

/** A stable small number from a name, so a drop without an image always gets the same art. */
export function hashName(name) {
  let h = 2166136261;
  for (const ch of String(name)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

/** One drop card. The generated art mixes theme tokens, so it follows light and dark by itself. */
export function dropCardMarkup(drop) {
  const h = hashName(drop.name);
  const art = [
    `--m1:${20 + (h % 61)}%`,
    `--m2:${15 + ((h >>> 4) % 56)}%`,
    `--x:${14 + ((h >>> 8) % 40)}%`,
    `--y:${10 + ((h >>> 12) % 34)}%`,
    `--x2:${12 + ((h >>> 16) % 30)}%`,
    `--y2:${14 + ((h >>> 20) % 28)}%`,
    `--rot:${(h >>> 24) % 90}deg`,
  ].join(';');
  const img = drop.imageUrl ? `<img src="${escapeHtml(drop.imageUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : '';
  return (
    `<li class="drop"><div class="art" style="${art}">${img}</div>` +
    `<div class="drop-b"><h3>${escapeHtml(drop.name)}</h3><div class="meta">${escapeHtml(drop.chain)}</div>` +
    `<div class="row"><span class="tag${drop.live ? ' live' : ''}">${escapeHtml(drop.tag)}</span>` +
    `<span class="price">${escapeHtml(drop.price)}</span></div></div></li>`
  );
}

/** The scrolling track: the real list, then a copy hidden from assistive tech so the loop is seamless. */
export function stripMarkup(drops) {
  const items = drops.map(dropCardMarkup).join('');
  return `<ul class="mq-track">${items}</ul><ul class="mq-track" aria-hidden="true">${items}</ul>`;
}

/** "Updated 4 min ago" from the feed's own timestamp, or '' when it is missing or in the future. */
export function updatedAgo(fetchedAtIso, nowMs) {
  const t = Date.parse(fetchedAtIso);
  if (Number.isNaN(t) || t > nowMs) return '';
  const mins = Math.round((nowMs - t) / 60_000);
  if (mins < 1) return 'Updated just now';
  if (mins < 60) return `Updated ${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `Updated ${hours} h ago` : '';
}

export async function mountDropsStrip(section, { apiBase = '/api', fetchImpl = (...args) => fetch(...args), now = () => Date.now(), search = window.location.search } = {}) {
  const track = section?.querySelector('[data-drops-track]');
  const note = section?.querySelector('[data-drops-note]');
  if (!section || !track) return;

  let drops = [];
  let noteText = '';
  if (new URLSearchParams(search).get(SAMPLE_PARAM) === '1') {
    const { SAMPLE_DROPS } = await import('./sample-drops.js');
    drops = SAMPLE_DROPS;
    noteText = 'Sample drops, for previewing the design.';
  } else {
    try {
      const res = await fetchImpl(`${apiBase}/home/drops?window=7d`, { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const feed = await res.json();
      drops = toStripDrops(feed, { now: now() });
      noteText = ['Live from OpenSea', updatedAgo(feed.fetchedAt, now())].filter(Boolean).join(' · ');
    } catch {
      return; // feed unreachable: the section simply stays hidden
    }
  }
  if (drops.length < MIN_TO_SHOW) return;

  track.innerHTML = stripMarkup(drops);
  if (note) note.textContent = noteText;
  section.hidden = false;
  // Nobody is looking at the strip while it is off screen, so let it rest.
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver(([entry]) => track.classList.toggle('is-paused', !entry.isIntersecting)).observe(track);
  }
}
