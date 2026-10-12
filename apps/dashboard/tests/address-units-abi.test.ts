import { describe, expect, it } from 'vitest';
import { addressProblemText, checkAddress, sameAddress, toChecksumAddress, ZERO_ADDRESS } from '../src/lib/address';
import { amountProblemText, formatWei, parseAmount, sumWei, weiToDecimalString } from '../src/lib/units';
import { DISPERSE_ETHER_SELECTOR, encodeDisperseEther } from '../src/lib/disperse-abi';

// The test vectors published in EIP-55 itself, plus real mainnet addresses.
const CHECKSUMMED = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];
const ALL_CAPS = ['0x52908400098527886E0F7030069857D2E4169EE7', '0x8617E340B3D01FA5F11F306F4090FD50E238070D'];
const ALL_LOWER = ['0xde709f2102306220921060314715629080e2fb77', '0x27b1fdb04752bbc536007a920d24acb045561c26'];

describe('EIP-55 checksum', () => {
  it('reproduces every published EIP-55 checksummed test vector', () => {
    for (const a of CHECKSUMMED) expect(toChecksumAddress(a.toLowerCase())).toBe(a);
    // The EIP's "all caps" and "all lower" vectors are the edge cases whose correct checksum IS all caps / all lowercase.
    for (const a of ALL_CAPS) expect(toChecksumAddress(a.toLowerCase())).toBe(a);
    for (const a of ALL_LOWER) expect(toChecksumAddress(a)).toBe(a);
  });

  it('accepts a correct mixed-case address and reports the checksum as verified', () => {
    for (const a of CHECKSUMMED) expect(checkAddress(a)).toEqual({ ok: true, address: a, checksum: 'verified' });
  });

  it('accepts all-lowercase and all-uppercase (no checksum to verify), returning the checksummed form', () => {
    for (const a of [...ALL_CAPS, ...ALL_LOWER]) {
      const r = checkAddress(a);
      expect(r.ok && r.checksum).toBe('none');
      expect(r.ok && r.address).toBe(toChecksumAddress(a.toLowerCase()));
    }
  });

  it('REJECTS a mixed-case address whose checksum is wrong, for every single-character case flip', () => {
    const good = CHECKSUMMED[0]!;
    let flipped = 0;
    for (let i = 2; i < good.length; i++) {
      const c = good[i]!;
      if (!/[a-fA-F]/.test(c)) continue;
      const bad = good.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + good.slice(i + 1);
      expect(checkAddress(bad), bad).toEqual({ ok: false, problem: 'checksum' });
      flipped++;
    }
    expect(flipped).toBeGreaterThan(15);
  });

  it('rejects anything that is not 0x plus 40 hex characters', () => {
    for (const bad of ['', '0x', '0x123', CHECKSUMMED[0]!.slice(2), CHECKSUMMED[0] + '00', '0xZZAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'vitalik.eth', ' ']) {
      expect(checkAddress(bad), JSON.stringify(bad)).toEqual({ ok: false, problem: 'format' });
    }
  });

  it('rejects the zero address, in any capitalisation', () => {
    expect(checkAddress(ZERO_ADDRESS)).toEqual({ ok: false, problem: 'zero' });
    expect(checkAddress('0x' + '0'.repeat(40).toUpperCase())).toEqual({ ok: false, problem: 'zero' });
  });

  it('trims surrounding whitespace, and compares addresses case-insensitively', () => {
    expect(checkAddress(`  ${CHECKSUMMED[1]}\n`).ok).toBe(true);
    expect(sameAddress(CHECKSUMMED[1]!, CHECKSUMMED[1]!.toLowerCase())).toBe(true);
  });

  it('gives each problem a plain sentence', () => {
    for (const p of ['format', 'checksum', 'zero'] as const) expect(addressProblemText(p).length).toBeGreaterThan(10);
  });
});

describe('parseAmount (exact, strict)', () => {
  it('converts decimals to wei exactly, with no floating point', () => {
    expect(parseAmount('1')).toEqual({ ok: true, wei: 10n ** 18n });
    expect(parseAmount('0.001')).toEqual({ ok: true, wei: 10n ** 15n });
    expect(parseAmount('0.0025')).toEqual({ ok: true, wei: 2_500_000_000_000_000n });
    expect(parseAmount('123.456789012345678')).toEqual({ ok: true, wei: 123_456_789_012_345_678_000n });
    expect(parseAmount('0.000000000000000001')).toEqual({ ok: true, wei: 1n });
    expect(parseAmount('  0.5  ')).toEqual({ ok: true, wei: 5n * 10n ** 17n });
  });

  it('handles values a float would corrupt', () => {
    expect(parseAmount('0.1')).toEqual({ ok: true, wei: 10n ** 17n });
    expect(parseAmount('9007199254740993')).toEqual({ ok: true, wei: 9007199254740993n * 10n ** 18n }); // beyond 2^53
    expect(parseAmount('340282366920938463463.374607431768211455')).toMatchObject({ ok: true });
  });

  it('REJECTS more than 18 decimal places instead of rounding (viem rounds these silently)', () => {
    expect(parseAmount('0.0000000000000000001')).toEqual({ ok: false, problem: 'decimals' });
    expect(parseAmount('1.1234567890123456789')).toEqual({ ok: false, problem: 'decimals' });
  });

  it('rejects zero, negatives, exponents, separators and anything not a plain decimal', () => {
    expect(parseAmount('0')).toEqual({ ok: false, problem: 'zero' });
    expect(parseAmount('0.000')).toEqual({ ok: false, problem: 'zero' });
    for (const bad of ['', '-1', '+1', '1e18', '1,5', '1_000', '.5', '5.', 'abc', '0x10', '1 2', 'Infinity', 'NaN']) {
      expect(parseAmount(bad), JSON.stringify(bad)).toEqual({ ok: false, problem: 'format' });
    }
  });

  it('gives each problem a plain sentence', () => {
    for (const p of ['format', 'decimals', 'zero'] as const) expect(amountProblemText(p).length).toBeGreaterThan(10);
  });
});

describe('formatWei and sums', () => {
  it('round-trips exactly and trims trailing zeros', () => {
    for (const s of ['1', '0.001', '0.0025', '123.456789012345678', '0.000000000000000001', '50']) {
      const parsed = parseAmount(s);
      expect(parsed.ok && formatWei(parsed.wei)).toBe(s);
    }
    expect(formatWei(0n)).toBe('0');
    expect(weiToDecimalString(1_500_000_000_000_000n)).toBe('0.0015');
  });

  it('formats a negative amount (a shortfall) with its sign', () => {
    expect(formatWei(-1_500_000_000_000_000n)).toBe('-0.0015');
  });

  it('sums without losing precision', () => {
    expect(sumWei([1n, 2n, 3n])).toBe(6n);
    expect(sumWei([])).toBe(0n);
    expect(sumWei([10n ** 30n, 1n])).toBe(10n ** 30n + 1n);
  });
});

describe('encodeDisperseEther (checked against viem, generated in a scratch script)', () => {
  const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', B = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', C = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';

  it('matches the reference encoding for two recipients', () => {
    expect(encodeDisperseEther([A, B], [10n ** 15n, 2_500_000_000_000_000n])).toBe(
      '0xe63d38ed000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000020000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed000000000000000000000000fb6916095ca1df60bb79ce92ce3ea74c37c5d359000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000008e1bc9bf04000',
    );
  });

  it('matches for one recipient, three recipients (incl. a value near 2^128), and none', () => {
    expect(encodeDisperseEther([C], [1n])).toBe(
      '0xe63d38ed000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000001000000000000000000000000dbf03b407c01e7cd3cbea99509d93f8dddc8c6fb00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001',
    );
    expect(encodeDisperseEther([A, B, C], [1n, 22n, 340282366920938463463374607431768211455n])).toBe(
      '0xe63d38ed000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000030000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed000000000000000000000000fb6916095ca1df60bb79ce92ce3ea74c37c5d359000000000000000000000000dbf03b407c01e7cd3cbea99509d93f8dddc8c6fb00000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000ffffffffffffffffffffffffffffffff',
    );
    expect(encodeDisperseEther([], [])).toBe(
      '0xe63d38ed0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    );
  });

  it('starts with the disperseEther selector and has the right length for any n', () => {
    const many = Array.from({ length: 100 }, () => A);
    const data = encodeDisperseEther(many, many.map(() => 1n));
    expect(data.startsWith(DISPERSE_ETHER_SELECTOR)).toBe(true);
    expect((data.length - 2 - 8) / 64).toBe(2 + 2 + 2 * 100); // two offsets, two lengths, 2n words
  });

  it('refuses mismatched lengths, a bad address, and an out-of-range value', () => {
    expect(() => encodeDisperseEther([A], [1n, 2n])).toThrow('same length');
    expect(() => encodeDisperseEther(['0x123'], [1n])).toThrow('not an address');
    expect(() => encodeDisperseEther([A], [-1n])).toThrow('out of range');
    expect(() => encodeDisperseEther([A], [1n << 256n])).toThrow('out of range');
  });
});
