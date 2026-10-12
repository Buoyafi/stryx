import { describe, expect, it } from 'vitest';
import { formatUnits, weiToEther, weiToGwei } from '../src/lib/wei-format';

describe('formatUnits', () => {
  it('formats a whole number with no fractional part, no trailing dot', () => {
    expect(formatUnits('1000000000000000000', 18)).toBe('1');
  });

  it('formats a fractional value and trims trailing zeros', () => {
    expect(formatUnits('1500000000000000000', 18)).toBe('1.5');
  });

  it('keeps precision that Number(wei)/1e18 would lose for large values', () => {
    // Too large for a float: it must come out exact.
    expect(formatUnits('123456789012345678', 18)).toBe('0.123456789012345678');
  });

  it('formats zero as "0"', () => {
    expect(formatUnits('0', 18)).toBe('0');
  });

  it('formats a negative value with a leading minus', () => {
    expect(formatUnits('-1500000000000000000', 18)).toBe('-1.5');
  });

  it('pads a sub-unit fractional value with leading zeros before trimming trailing ones', () => {
    expect(formatUnits('5', 18)).toBe('0.000000000000000005');
  });
});

describe('weiToEther / weiToGwei', () => {
  it('weiToEther uses 18 decimals', () => {
    expect(weiToEther('1000000000000000000')).toBe('1');
  });

  it('weiToGwei uses 9 decimals: a typical gas price reads as a small, legible number', () => {
    expect(weiToGwei('1500000000')).toBe('1.5');
  });

  it('a typical gas-used * gas-price value in wei converts to a legible gwei price', () => {
    // The price alone, not the total fee, is what shows as "1.2 gwei".
    expect(weiToGwei('1200000000')).toBe('1.2');
  });
});
