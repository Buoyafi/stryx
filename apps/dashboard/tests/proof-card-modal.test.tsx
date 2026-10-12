// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProofCardModal } from '../src/components/ProofCardModal';
import type { HistoryEntry } from '../src/lib/mint-history';

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return { ...actual, apiRequest: vi.fn(async () => ({ openSea: { collectionName: 'Ursa Genesis Pass', imageUrl: null } })) };
});

const A = '0x' + 'a'.repeat(40);
const entry: HistoryEntry = {
  id: 'e', kind: 'signed', at: Date.parse('2026-09-30T10:00:00Z'), chainId: 8453, nftContract: A, stageLabel: 'FCFS',
  legs: [{ id: 'l1', walletId: 'w1', status: 'confirmed', quantity: 3, address: '0x' + 'b'.repeat(40), hash: '0x' + 'c'.repeat(64), landedMs: 1900 }],
};

/** jsdom has no canvas: hand back a 2D context that records the text drawn. */
const texts: string[] = [];
beforeEach(() => {
  texts.length = 0;
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === 'fillText') return (t: string) => void texts.push(t);
      if (prop === 'measureText') return (t: string) => ({ width: t.length * 7 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  // jsdom never loads images: hand back a stand-in that loads at once.
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = '';
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  document.documentElement.dataset.theme = 'dark';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProofCardModal entry={entry} onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe('ProofCardModal', () => {
  it('paints the card for the collection, and enables the actions once it has', async () => {
    mount();
    const dialog = screen.getByRole('dialog', { name: 'Proof of mint' });
    expect(within(dialog).getByRole('button', { name: 'Save image' })).toHaveProperty('disabled', true); // still painting
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save image' })).toHaveProperty('disabled', false));
    expect(texts).toEqual(expect.arrayContaining(['Ursa Genesis Pass', '3', '1.9s']));
    expect(texts).not.toContain('PROOF OF MINT'); // the wordmark image heads the card
    expect(within(dialog).getByRole('img', { name: /Ursa Genesis Pass: 1 of 1 confirmed/ })).not.toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Print' })).toHaveProperty('disabled', false);
  });

  it('keeps addresses off the card until asked, and repaints when asked', async () => {
    mount();
    await waitFor(() => expect(texts.length).toBeGreaterThan(5));
    expect(texts.some((t) => t.includes('0xbbbb'))).toBe(false);
    const box = screen.getByRole('checkbox', { name: /Show wallet addresses/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    texts.length = 0;
    fireEvent.click(box);
    await waitFor(() => expect(texts.some((t) => t.includes('0xbbbb…bbbb'))).toBe(true));
  });

  it('links to the transaction on the block explorer', () => {
    mount();
    const link = screen.getByRole('link', { name: /open the transaction/ });
    expect(link.getAttribute('href')).toBe(`https://basescan.org/tx/0x${'c'.repeat(64)}`);
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('closes on Close, on Escape and on a tap outside, but not on a tap inside', () => {
    const onClose = mount();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.modal-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
