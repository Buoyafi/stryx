import { describe, expect, it } from 'vitest';
import { addressGradient } from '../src/lib/avatar';

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const B = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

describe('addressGradient', () => {
  it('is deterministic: the same address always produces the same gradient', () => {
    expect(addressGradient(A)).toEqual(addressGradient(A));
  });

  it('is case-insensitive: same address, different casing, same gradient', () => {
    expect(addressGradient(A)).toEqual(addressGradient(A.toLowerCase()));
  });

  it('produces a different gradient for a different address', () => {
    expect(addressGradient(A)).not.toEqual(addressGradient(B));
  });

  it('returns a hue-rotate amount and an angle in range (never a raw colour value)', () => {
    const g = addressGradient(A);
    expect(g.hueRotate).toBeGreaterThanOrEqual(0);
    expect(g.hueRotate).toBeLessThanOrEqual(360);
    expect(g.angle).toBeGreaterThanOrEqual(0);
    expect(g.angle).toBeLessThanOrEqual(360);
  });
});
