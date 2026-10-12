import { describe, expect, it } from 'vitest';
import { RISE_TARGETS, isAbove, staggerDelay } from '../src/lib/reveal.js';

describe('staggerDelay', () => {
  it('steps siblings 90ms apart and stops growing after the 8th so nobody waits', () => {
    expect([0, 1, 2].map((i) => staggerDelay(i))).toEqual([0, 90, 180]);
    expect(staggerDelay(7)).toBe(630);
    expect(staggerDelay(40)).toBe(630);
    expect(staggerDelay(-3)).toBe(0);
  });
});

describe('isAbove', () => {
  it('is true only for a block that has been scrolled completely past', () => {
    expect(isAbove({ bottom: -1 })).toBe(true);
    expect(isAbove({ bottom: 0 })).toBe(false);
    expect(isAbove({ bottom: 300 })).toBe(false);
  });
});

describe('RISE_TARGETS', () => {
  it('is a valid comma-separated selector list covering the page\'s blocks', () => {
    const parts = RISE_TARGETS.split(',').map((s) => s.trim());
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.length > 0)).toBe(true);
    expect(RISE_TARGETS).toContain('.bento > *');
    expect(RISE_TARGETS).toContain('.stage .console');
  });
});
