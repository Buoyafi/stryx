import { describe, expect, it } from 'vitest';
import { CARD_W, canCreateProof, durationLabel, markImageSource, wordmarkImageSource, paintProofCard, proofFileName, proofModel, type ProofAssets, type ProofTokens } from '../src/lib/proof-card';
import type { HistoryEntry, HistoryLeg } from '../src/lib/mint-history';

const T = Date.parse('2026-09-30T10:00:00Z');
const A = '0x' + 'a'.repeat(40);
const leg = (over: Partial<HistoryLeg> = {}): HistoryLeg => ({ id: 'l', walletId: 'w', status: 'confirmed', quantity: 3, address: '0x' + 'b'.repeat(40), hash: '0x' + 'c'.repeat(64), ...over });
const entry = (legs: HistoryLeg[], over: Partial<HistoryEntry> = {}): HistoryEntry => ({ id: 'e', kind: 'signed', at: T, chainId: 8453, nftContract: A, stageLabel: 'FCFS', legs, ...over });

describe('canCreateProof', () => {
  it('needs at least one confirmed mint, and a report that has loaded', () => {
    expect(canCreateProof(entry([leg()]))).toBe(true);
    expect(canCreateProof(entry([leg({ status: 'failed' })]))).toBe(false);
    expect(canCreateProof(entry([leg({ status: 'pending' })]))).toBe(false);
    expect(canCreateProof(entry([], { loading: true }))).toBe(false);
  });
});

describe('proofModel', () => {
  it('counts only what confirmed, and reads the speed from the confirmed wallets', () => {
    const m = proofModel(
      entry([
        leg({ id: '1', walletId: 'w1', landedMs: 1100 }),
        leg({ id: '2', walletId: 'w2', landedMs: 1900 }),
        leg({ id: '3', walletId: 'w3', status: 'failed', quantity: 3, hash: undefined, landedMs: 300 }),
      ]),
      { title: 'Ursa Genesis Pass', imageUrl: null },
    );
    expect(m).toMatchObject({ title: 'Ursa Genesis Pass', chainName: 'Base', kindLabel: 'FCFS stage', confirmed: 2, total: 3, nfts: 6, wallets: 2, firstMs: 1100, lastMs: 1900, explorerHost: 'basescan.org' });
    expect(m.txUrl).toBe(`https://basescan.org/tx/0x${'c'.repeat(64)}`);
    expect(m.addresses).toEqual(['0xbbbb…bbbb', '0xbbbb…bbbb']);
  });

  it('draws no speed line for a mint that is not a signed run', () => {
    const m = proofModel(entry([leg({ landedMs: 1000 })], { kind: 'scheduled' }), { title: 'X', imageUrl: null });
    expect(m).toMatchObject({ kindLabel: 'Scheduled mint', firstMs: null, lastMs: null });
    expect(proofModel(entry([leg()], { kind: 'direct' }), { title: 'X', imageUrl: null }).kindLabel).toBe('Mint');
  });

  it('copes with a chain this build does not know', () => {
    const m = proofModel(entry([leg()], { chainId: 999_999 }), { title: 'X', imageUrl: null });
    expect(m.chainName).toBe('Chain 999999');
    expect(m.txUrl).toBeNull();
    expect(m.explorerHost).toBeNull();
  });
});

describe('labels', () => {
  it('words a duration', () => {
    expect(durationLabel(1900)).toBe('1.9s');
    expect(durationLabel(12_400)).toBe('12s');
    expect(durationLabel(64_000)).toBe('1m 04s');
  });
  it('names the saved file after the collection and the day', () => {
    expect(proofFileName({ title: 'Ursa Genesis Pass!' }, T)).toBe('stryx-proof-ursa-genesis-pass-2026-09-30.png');
    expect(proofFileName({ title: '???' }, T)).toBe('stryx-proof-mint-2026-09-30.png');
  });
});

describe('markImageSource', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g stroke="currentColor"><ellipse/></g><circle class="stryx-e" r="3.4" fill="var(--stryx-accent, #7F77DD)"/><g><circle class="stryx-e stryx-e2" r="3.4" fill="var(--stryx-accent, #7F77DD)"/></g></svg>';
  it('writes the theme colours into the image and puts the electrons at fixed places', () => {
    const uri = decodeURIComponent(markImageSource(svg, { ink: 'INK', accent: 'ACC' }).replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    expect(uri).toContain('stroke="INK"');
    expect(uri).toContain('fill="ACC"');
    expect(uri).not.toContain('var(--stryx');
    expect(uri).not.toContain('class="stryx-e');
    expect(uri.match(/cx="[\d.]+" cy="[\d.]+" r="3.4"/g)).toHaveLength(2);
  });
});

describe('wordmarkImageSource', () => {
  it('writes the theme colours in, with the X in the accent, and gives the image a size', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -700 5260 700"><path fill="currentColor" d="M0 0"/><path stroke="var(--stryx-accent, #7F77DD)" d="M1 1"/></svg>';
    const uri = decodeURIComponent(wordmarkImageSource(svg, { ink: 'INK', accent: 'ACC' }).replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    expect(uri).toContain('fill="INK"');
    expect(uri).toContain('stroke="ACC"');
    expect(uri).not.toContain('var(--stryx');
    expect(uri).toMatch(/<svg width="[\d.]+" height="45" /);
  });
});

/** A 2D context that only records what was drawn. jsdom has no canvas, and this checks what the card SAYS. */
function fakeCtx() {
  const texts: string[] = [];
  const calls: string[] = [];
  const base: Record<string, unknown> = { canvas: { width: 0, height: 0 } };
  const ctx = new Proxy(base, {
    get(target, prop: string) {
      if (prop === 'fillText') return (t: string) => void texts.push(t);
      if (prop === 'measureText') return (t: string) => ({ width: t.length * 7 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return (...args: unknown[]) => void calls.push(`${prop}(${args.length})`);
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, calls };
}
const tokens: ProofTokens = { bg: 'b', card: 'c', ink: 'i', sub: 's', line: 'l', accent: 'a', onAccent: 'o', theme: 'dark' };
const noAssets: ProofAssets = { mark: null, art: null };

describe('paintProofCard', () => {
  const signed = proofModel(
    entry([leg({ id: '1', walletId: 'w1', landedMs: 1100 }), leg({ id: '2', walletId: 'w2', landedMs: 1900 })]),
    { title: 'Ursa Genesis Pass', imageUrl: null },
  );

  it('says what happened, and how fast, and where to check it', () => {
    const { ctx, texts } = fakeCtx();
    const height = paintProofCard(ctx, signed, { showAddresses: false }, tokens, noAssets);
    expect(height).toBeGreaterThan(300);
    expect(texts).toEqual(expect.arrayContaining(['STRYX', 'Ursa Genesis Pass', 'U', '6', 'ALL CONFIRMED', '1.9s', ' after open', 'Stage opens', 'Last 1.9s', 'First 1.1s', 'Result', '2 of 2 confirmed', 'Wallets', '2']));
    expect(texts.some((t) => t.includes('NFTs across 2 wallets'))).toBe(true);
    expect(texts.some((t) => t.startsWith('Verify on basescan.org'))).toBe(true);
    expect(texts.some((t) => t.startsWith('0xcccc'))).toBe(true);
  });

  it('heads the card with the Stryx wordmark, as in the app header, not a label', () => {
    const { ctx, texts, calls } = fakeCtx();
    paintProofCard(ctx, signed, { showAddresses: false }, tokens, { mark: {} as CanvasImageSource, wordmark: {} as CanvasImageSource, art: null });
    expect(calls.filter((c) => c === 'drawImage(5)')).toHaveLength(2);
    expect(texts).not.toContain('STRYX');
    expect(texts).not.toContain('PROOF OF MINT');
  });

  it('keeps wallet addresses off the card unless asked', () => {
    const off = fakeCtx();
    paintProofCard(off.ctx, signed, { showAddresses: false }, tokens, noAssets);
    expect(off.texts.some((t) => t.includes('0xbbbb'))).toBe(false);
    const on = fakeCtx();
    paintProofCard(on.ctx, signed, { showAddresses: true }, tokens, noAssets);
    expect(on.texts.some((t) => t.includes('0xbbbb…bbbb'))).toBe(true);
  });

  it('has no speed block for a run that was not signed, so the card is shorter', () => {
    const plain = proofModel(entry([leg()], { kind: 'direct' }), { title: 'X', imageUrl: null });
    const a = fakeCtx();
    const h1 = paintProofCard(a.ctx, plain, { showAddresses: false }, tokens, noAssets);
    const b = fakeCtx();
    const h2 = paintProofCard(b.ctx, signed, { showAddresses: false }, tokens, noAssets);
    expect(a.texts).not.toContain('ALL CONFIRMED');
    expect(h1).toBeLessThan(h2);
  });

  it('paints at the height it reported, and says a partial run is partial', () => {
    const partial = proofModel(entry([leg({ landedMs: 1500 }), leg({ id: '2', walletId: 'w2', status: 'failed', hash: undefined })]), { title: 'X', imageUrl: null });
    const { ctx, texts } = fakeCtx();
    const height = paintProofCard(ctx, partial, { showAddresses: false }, tokens, noAssets);
    const again = fakeCtx();
    expect(paintProofCard(again.ctx, partial, { showAddresses: false }, tokens, noAssets, height)).toBe(height);
    expect(texts).toContain('1 OF 2 CONFIRMED');
    expect(texts).toContain('Landed 1.5s');
    expect(CARD_W).toBe(360);
  });
});
