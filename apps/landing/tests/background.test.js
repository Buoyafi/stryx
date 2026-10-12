import { describe, expect, it } from 'vitest';
import { calmFactor, itemCountFor, parseHex } from '../src/lib/background.js';

const view = { width: 1440, height: 900, scrollY: 0 };

describe('calmFactor', () => {
  it('is calmest right behind the headline and full strength at the edges', () => {
    const centre = calmFactor(720, 414, view);
    const corner = calmFactor(20, 880, view);
    expect(centre).toBeCloseTo(0.28, 2);
    expect(corner).toBeCloseTo(1, 2);
    expect(centre).toBeLessThan(corner);
  });

  it('always stays within 0.28 and 1', () => {
    for (let x = 0; x <= 1440; x += 120) for (let y = 0; y <= 900; y += 100) {
      const c = calmFactor(x, y, view);
      expect(c).toBeGreaterThanOrEqual(0.28 - 1e-9);
      expect(c).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('moves the calm patch up with the page as it scrolls', () => {
    const before = calmFactor(720, 414, view);
    const after = calmFactor(720, 414, { ...view, scrollY: 600 });
    expect(after).toBeGreaterThan(before);
    expect(calmFactor(720, 414 - 600, { ...view, scrollY: 600 })).toBeCloseTo(before, 5);
  });
});

describe('itemCountFor', () => {
  it('scales with the screen between 46 and 150', () => {
    expect(itemCountFor(390, 844)).toBe(46);
    expect(itemCountFor(1440, 900)).toBeGreaterThan(46);
    expect(itemCountFor(3840, 2160)).toBe(150);
  });
});

describe('parseHex', () => {
  it('reads #RRGGBB (as the brand tokens are written), with or without padding', () => {
    expect(parseHex('#CCFF00')).toEqual([204, 255, 0]);
    expect(parseHex('  #d9a55b ')).toEqual([217, 165, 91]);
  });
  it('returns null for anything else, so the built-in colours stay in use', () => {
    for (const bad of ['', 'red', '#fff', 'rgb(1,2,3)', null, undefined]) expect(parseHex(bad)).toBeNull();
  });
});
