/**
 * The proof-of-mint card: what it says (pure, tested) and how it is painted onto a canvas (so it saves
 * as one PNG that looks the same everywhere, in the app's current theme).
 */

import { chainById, explorerTxUrl } from '@stryx/chains';
import { countLegs, type HistoryEntry } from './mint-history';

export function canCreateProof(entry: HistoryEntry): boolean {
  return !entry.loading && countLegs(entry.legs).confirmed > 0;
}

export interface ProofModel {
  title: string;
  imageUrl: string | null;
  chainName: string;
  /** "FCFS stage", "Scheduled mint" or "Mint". */
  kindLabel: string;
  whenLabel: string;
  confirmed: number;
  total: number;
  /** NFTs across the confirmed wallets. */
  nfts: number;
  wallets: number;
  /** Signed runs: ms after the stage opened that the first and last confirmed mint landed. */
  firstMs: number | null;
  lastMs: number | null;
  txHash: string | null;
  txUrl: string | null;
  explorerHost: string | null;
  /** Short addresses of the confirmed wallets, only shown if the person chooses to. */
  addresses: string[];
}

const short = (v: string) => (v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);

export function proofModel(entry: HistoryEntry, info: { title: string; imageUrl: string | null }): ProofModel {
  const chain = chainById(entry.chainId);
  const confirmedLegs = entry.legs.filter((l) => l.status === 'confirmed');
  const landed = confirmedLegs.map((l) => l.landedMs).filter((v): v is number => v !== undefined);
  const withHash = confirmedLegs.find((l) => l.hash);
  const explorerHost = (() => {
    try {
      return chain?.explorerUrl ? new URL(chain.explorerUrl).host : null;
    } catch {
      return null;
    }
  })();
  return {
    title: info.title,
    imageUrl: info.imageUrl,
    chainName: chain?.name ?? `Chain ${entry.chainId}`,
    kindLabel: entry.kind === 'signed' ? (entry.stageLabel ? `${entry.stageLabel} stage` : 'Signed mint') : entry.kind === 'scheduled' ? 'Scheduled mint' : 'Mint',
    whenLabel: new Date(entry.at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    confirmed: confirmedLegs.length,
    total: entry.legs.length,
    nfts: confirmedLegs.reduce((sum, l) => sum + (l.quantity ?? 0), 0),
    wallets: new Set(confirmedLegs.map((l) => l.walletId || l.id)).size,
    firstMs: entry.kind === 'signed' && landed.length > 0 ? Math.min(...landed) : null,
    lastMs: entry.kind === 'signed' && landed.length > 0 ? Math.max(...landed) : null,
    txHash: withHash?.hash ?? null,
    txUrl: (withHash?.hash && chain ? explorerTxUrl(chain, withHash.hash) : undefined) ?? null,
    explorerHost,
    addresses: confirmedLegs.map((l) => (l.address ? short(l.address) : '')).filter(Boolean),
  };
}

/** "1.9s", "12s", "1m 04s". */
export function durationLabel(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** The file name a saved card gets: stryx-proof-<collection>-<date>.png. */
export function proofFileName(model: Pick<ProofModel, 'title'>, at: number): string {
  const slug = model.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mint';
  return `stryx-proof-${slug}-${new Date(at).toISOString().slice(0, 10)}.png`;
}

// ---------------------------------------------------------------- painting

export interface ProofTokens {
  bg: string;
  card: string;
  ink: string;
  sub: string;
  line: string;
  accent: string;
  onAccent: string;
  theme: 'dark' | 'light';
}

export function readProofTokens(root: HTMLElement = document.documentElement): ProofTokens {
  const style = getComputedStyle(root);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return {
    bg: get('--stryx-bg'),
    card: get('--stryx-card'),
    ink: get('--stryx-ink'),
    sub: get('--stryx-sub'),
    line: get('--stryx-line'),
    accent: get('--stryx-accent'),
    onAccent: get('--stryx-on-accent'),
    theme: root.dataset.theme === 'light' ? 'light' : 'dark',
  };
}

export interface ProofAssets {
  mark: CanvasImageSource | null;
  /** The STRYX wordmark beside the mark, as in the header. Without it the name is set in type. */
  wordmark?: CanvasImageSource | null;
  art: CanvasImageSource | null;
}

/** The wordmark's drawn height on the card; its width follows the SVG's 5260 x 700 viewBox. */
const WORDMARK_H = 15;
const WORDMARK_W = (WORDMARK_H * 5260) / 700;

export interface ProofOptions {
  showAddresses: boolean;
}

/** Logical size of the card. The canvas is painted at SCALE times this, so the PNG is sharp. */
export const CARD_W = 360;
export const MARGIN = 20;
export const SCALE = 3;

const FONT = '"Inter Variable", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

type Ctx = CanvasRenderingContext2D;

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function ellipsize(ctx: Ctx, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function font(ctx: Ctx, weight: number, size: number, family = FONT): void {
  ctx.font = `${weight} ${size}px ${family}`;
}

function spaced(ctx: Ctx, value: string): void {
  // Letter spacing is a newer canvas property: without it the label is simply set tight.
  (ctx as unknown as { letterSpacing?: string }).letterSpacing = value;
}

/** Paints the card and returns its height in logical units. */
export function paintProofCard(ctx: Ctx, m: ProofModel, o: ProofOptions, t: ProofTokens, a: ProofAssets, cardHeight?: number): number {
  const W = CARD_W;
  const pad = 24;
  const H = cardHeight ?? 2000;
  ctx.save();
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'alphabetic';

  // The sheet behind the card, then the card.
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W + MARGIN * 2, H + MARGIN * 2);
  ctx.translate(MARGIN, MARGIN);
  roundRect(ctx, 0, 0, W, H, 30);
  ctx.fillStyle = t.card;
  ctx.fill();
  // A soft glow of the accent from the top, the way the app's cards catch it.
  ctx.save();
  roundRect(ctx, 0, 0, W, H, 30);
  ctx.clip();
  const glow = ctx.createRadialGradient(W / 2, -10, 10, W / 2, -10, 260);
  glow.addColorStop(0, t.accent);
  glow.addColorStop(1, t.card);
  ctx.globalAlpha = t.theme === 'dark' ? 0.16 : 0.2;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 300);
  ctx.restore();
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 30);
  ctx.strokeStyle = t.line;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Header: the Stryx lockup (mark and wordmark, as in the app header) on the left, the chain on the right.
  let y = pad;
  if (a.mark) ctx.drawImage(a.mark, pad, y - 2, 24, 24);
  ctx.textAlign = 'left';
  if (a.wordmark) {
    ctx.drawImage(a.wordmark, pad + 32, y + 10 - WORDMARK_H / 2, WORDMARK_W, WORDMARK_H);
  } else {
    font(ctx, 750, 15);
    spaced(ctx, '2px');
    ctx.fillStyle = t.ink;
    ctx.fillText('STRYX', pad + 32, y + 15);
    spaced(ctx, '0px');
  }
  font(ctx, 560, 12);
  const chainLabel = ellipsize(ctx, m.chainName, 130);
  const chipW = ctx.measureText(chainLabel).width + 32;
  roundRect(ctx, W - pad - chipW, y - 1, chipW, 24, 12);
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = t.ink;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(W - pad - chipW + 12, y + 11, 4, 0, Math.PI * 2);
  ctx.fillStyle = t.accent;
  ctx.fill();
  ctx.fillStyle = t.ink;
  ctx.fillText(chainLabel, W - pad - chipW + 22, y + 15);

  // The collection's art, or a monogram tile when there is none (or it could not be read).
  y += 46;
  const artSize = 112;
  const artX = (W - artSize) / 2;
  ctx.save();
  roundRect(ctx, artX, y, artSize, artSize, 32);
  ctx.clip();
  if (a.art) {
    ctx.drawImage(a.art, artX, y, artSize, artSize);
  } else {
    const g = ctx.createLinearGradient(artX, y, artX + artSize, y + artSize);
    g.addColorStop(0, t.accent);
    g.addColorStop(1, t.ink);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = g;
    ctx.fillRect(artX, y, artSize, artSize);
    ctx.globalAlpha = 1;
    font(ctx, 650, 44);
    ctx.fillStyle = t.onAccent;
    ctx.textAlign = 'center';
    ctx.fillText((m.title.trim().charAt(0) || '?').toUpperCase(), W / 2, y + artSize / 2 + 15);
  }
  ctx.restore();
  // The seal: a check on a small disc at the tile's corner.
  const sealX = artX + artSize - 6;
  const sealY = y + artSize - 6;
  ctx.beginPath();
  ctx.arc(sealX, sealY, 18, 0, Math.PI * 2);
  ctx.fillStyle = t.card;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = t.line;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sealX - 7, sealY + 0.5);
  ctx.lineTo(sealX - 2, sealY + 5.5);
  ctx.lineTo(sealX + 7, sealY - 5);
  ctx.strokeStyle = t.ink;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Name and stage.
  y += artSize + 34;
  ctx.textAlign = 'center';
  font(ctx, 650, 22);
  ctx.fillStyle = t.ink;
  ctx.fillText(ellipsize(ctx, m.title, W - pad * 2), W / 2, y);
  y += 22;
  font(ctx, 500, 13);
  ctx.fillStyle = t.sub;
  ctx.fillText(`${m.kindLabel} · ${m.whenLabel}`, W / 2, y);

  // The big number.
  y += 56;
  const big = String(m.nfts);
  const suffix = ` NFT${m.nfts === 1 ? '' : 's'} across ${m.wallets} wallet${m.wallets === 1 ? '' : 's'}`;
  font(ctx, 650, 52);
  const bigW = ctx.measureText(big).width;
  font(ctx, 520, 15);
  const sufW = ctx.measureText(suffix).width;
  const startX = Math.max(pad, (W - (bigW + 8 + sufW)) / 2);
  ctx.textAlign = 'left';
  font(ctx, 650, 52);
  ctx.fillStyle = t.ink;
  ctx.fillText(big, startX, y);
  font(ctx, 520, 15);
  ctx.fillStyle = t.sub;
  ctx.fillText(ellipsize(ctx, suffix, W - pad - (startX + bigW + 8)), startX + bigW + 8, y);

  // Speed from the stage opening (signed runs only): the line only Stryx can draw.
  y += 24;
  if (m.lastMs !== null) {
    const boxH = 92;
    roundRect(ctx, pad, y, W - pad * 2, boxH, 20);
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = t.ink;
    ctx.fill();
    ctx.globalAlpha = 1;
    roundRect(ctx, pad + 0.5, y + 0.5, W - pad * 2 - 1, boxH - 1, 20);
    ctx.strokeStyle = t.line;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    font(ctx, 560, 11);
    spaced(ctx, '0.4px');
    ctx.fillStyle = t.sub;
    ctx.fillText(m.confirmed === m.total ? 'ALL CONFIRMED' : `${m.confirmed} OF ${m.total} CONFIRMED`, pad + 16, y + 30);
    spaced(ctx, '0px');
    ctx.textAlign = 'right';
    font(ctx, 500, 15);
    const tail = ' after open';
    const tailW = ctx.measureText(tail).width;
    ctx.fillStyle = t.ink;
    ctx.fillText(tail, W - pad - 16, y + 32);
    font(ctx, 650, 22);
    ctx.fillStyle = t.theme === 'dark' ? t.accent : t.ink;
    ctx.fillText(durationLabel(m.lastMs), W - pad - 16 - tailW, y + 32);

    // The timeline: the stage opening, the first mint to land, the last.
    const x0 = pad + 22;
    const x1 = W - pad - 22;
    const ty = y + 56;
    roundRect(ctx, x0, ty - 3, x1 - x0, 6, 3);
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = t.ink;
    ctx.fill();
    ctx.globalAlpha = 1;
    roundRect(ctx, x0, ty - 3, x1 - x0, 6, 3);
    ctx.fillStyle = t.accent;
    ctx.fill();
    const showFirst = m.firstMs !== null && m.firstMs < m.lastMs * 0.8 && m.confirmed > 1;
    const dot = (x: number, color: string) => {
      ctx.beginPath();
      ctx.arc(x, ty, 6, 0, Math.PI * 2);
      ctx.fillStyle = t.card;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    const firstX = m.firstMs !== null ? x0 + ((x1 - x0) * m.firstMs) / m.lastMs : x0;
    dot(x0, t.sub);
    if (showFirst) dot(firstX, t.accent);
    dot(x1, t.accent);
    font(ctx, 560, 10.5);
    ctx.fillStyle = t.sub;
    ctx.textAlign = 'left';
    ctx.fillText('Stage opens', x0 - 6, ty + 24);
    ctx.textAlign = 'right';
    ctx.fillText(m.confirmed > 1 ? `Last ${durationLabel(m.lastMs)}` : `Landed ${durationLabel(m.lastMs)}`, x1 + 6, ty + 24);
    if (showFirst && m.firstMs !== null) {
      ctx.textAlign = 'center';
      const cx = Math.min(Math.max(firstX, x0 + 78), x1 - 78);
      ctx.fillText(`First ${durationLabel(m.firstMs)}`, cx, ty + 24);
    }
    y += boxH + 6;
  }

  // Facts.
  const row = (label: string, value: string, mono = false) => {
    y += 40;
    ctx.textAlign = 'left';
    font(ctx, 500, 14);
    ctx.fillStyle = t.sub;
    ctx.fillText(label, pad, y);
    ctx.textAlign = 'right';
    font(ctx, 600, mono ? 13 : 14, mono ? MONO : FONT);
    ctx.fillStyle = t.ink;
    ctx.fillText(ellipsize(ctx, value, W - pad * 2 - 90), W - pad, y);
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = t.ink;
    ctx.fillRect(pad, y + 14, W - pad * 2, 1);
    ctx.globalAlpha = 1;
  };
  y -= 6;
  row('Result', `${m.confirmed} of ${m.total} confirmed`);
  if (o.showAddresses && m.addresses.length > 0) {
    const shown = m.addresses.slice(0, 3);
    row(m.addresses.length === 1 ? 'Wallet' : 'Wallets', `${shown.join(', ')}${m.addresses.length > shown.length ? ` +${m.addresses.length - shown.length}` : ''}`, true);
  } else {
    row('Wallets', String(m.wallets));
  }

  // Footer: the hash, and where anyone can check it.
  y += 40;
  if (m.txHash) {
    font(ctx, 500, 12, MONO);
    const hash = short(m.txHash);
    const hw = ctx.measureText(hash).width + 20;
    roundRect(ctx, pad, y - 15, hw, 24, 8);
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = t.ink;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.fillStyle = t.ink;
    ctx.fillText(hash, pad + 10, y + 1);
    if (m.explorerHost) {
      font(ctx, 600, 12);
      const room = W - pad * 2;
      // Beside the hash when both fit with a gap; otherwise on the line below, so they never overlap.
      const sameRow = ctx.measureText(`Verify on ${m.explorerHost} ↗`).width + hw + 16 <= room;
      if (!sameRow) y += 30;
      const label = ellipsize(ctx, `Verify on ${m.explorerHost} ↗`, room);
      ctx.textAlign = sameRow ? 'right' : 'left';
      ctx.fillStyle = t.ink;
      ctx.fillText(label, sameRow ? W - pad : pad, y + 1);
    }
  } else {
    ctx.textAlign = 'left';
    font(ctx, 500, 12);
    ctx.fillStyle = t.sub;
    ctx.fillText('Minted with Stryx', pad, y + 1);
  }

  const height = Math.ceil(y + 26);
  ctx.restore();
  return height;
}

// ---------------------------------------------------------------- assets

/**
 * Loads an image; null if it cannot be read (blocked, offline, not allowed to be drawn onto a canvas)
 * or takes longer than `timeoutMs`, so one slow collection image never leaves the card unpainted.
 */
export function loadImage(src: string, crossOrigin = false, timeoutMs = 4000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const done = (value: HTMLImageElement | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = src;
  });
}

/** The Stryx mark as a standalone image. */
export function markImageSource(markSvg: string, t: Pick<ProofTokens, 'ink' | 'accent'>): string {
  const angles = [0.08, 0.41, 0.74];
  let i = 0;
  const withElectrons = markSvg.replace(/<circle class="stryx-e[^"]*" r="3\.4"/g, () => {
    const theta = angles[i++ % angles.length]! * Math.PI * 2;
    return `<circle cx="${(32 - 12 * Math.sin(theta)).toFixed(2)}" cy="${(32 - 28 * Math.cos(theta)).toFixed(2)}" r="3.4"`;
  });
  return svgImageSource(withElectrons, t);
}

/** The wordmark as a standalone image, in the theme's colours (the X in the accent), sized so it rasterises sharp. */
export function wordmarkImageSource(wordmarkSvg: string, t: Pick<ProofTokens, 'ink' | 'accent'>): string {
  const sized = wordmarkSvg.replace(/<svg /, `<svg width="${WORDMARK_W * SCALE}" height="${WORDMARK_H * SCALE}" `);
  return svgImageSource(sized, t);
}

function svgImageSource(svg: string, t: Pick<ProofTokens, 'ink' | 'accent'>): string {
  const colored = svg.replace(/var\(--stryx-accent,\s*[^)]*\)/g, t.accent).replace(/currentColor/g, t.ink);
  const withNs = colored.includes('xmlns=') ? colored : colored.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNs)}`;
}
