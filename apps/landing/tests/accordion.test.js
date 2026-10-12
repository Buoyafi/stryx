import { describe, expect, it } from 'vitest';
import { toggleAccordionItem } from '../src/lib/accordion.js';

const closed = (n) => Array.from({ length: n }, () => ({ open: false }));

describe('toggleAccordionItem', () => {
  it('opens a closed item', () => {
    const result = toggleAccordionItem(closed(3), 1);
    expect(result.map((i) => i.open)).toEqual([false, true, false]);
  });

  it('closes an already-open item (toggling it again)', () => {
    const opened = toggleAccordionItem(closed(3), 1);
    const result = toggleAccordionItem(opened, 1);
    expect(result.map((i) => i.open)).toEqual([false, false, false]);
  });

  it('opening a different item closes whichever was open, only one open at a time', () => {
    const opened = toggleAccordionItem(closed(3), 0);
    const result = toggleAccordionItem(opened, 2);
    expect(result.map((i) => i.open)).toEqual([false, false, true]);
  });

  it('does not mutate the input array', () => {
    const items = closed(3);
    const snapshot = items.map((i) => ({ ...i }));
    toggleAccordionItem(items, 1);
    expect(items).toEqual(snapshot);
  });
});
