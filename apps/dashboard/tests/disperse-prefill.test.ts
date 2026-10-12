// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readAndClearDisprefill, writeDisprefill } from '../src/lib/disperse-prefill';

afterEach(() => sessionStorage.clear());

describe('disperse-prefill', () => {
  it('round-trips what was written', () => {
    writeDisprefill([{ address: '0x1111111111111111111111111111111111111a', label: 'Mint-01' }]);
    expect(readAndClearDisprefill()).toEqual([{ address: '0x1111111111111111111111111111111111111a', label: 'Mint-01' }]);
  });

  it('clears itself on read: a second read returns null', () => {
    writeDisprefill([{ address: '0x1111111111111111111111111111111111111a', label: null }]);
    readAndClearDisprefill();
    expect(readAndClearDisprefill()).toBeNull();
  });

  it('returns null when nothing was ever written', () => {
    expect(readAndClearDisprefill()).toBeNull();
  });

  it('treats malformed stored JSON as no prefill, not a thrown error', () => {
    sessionStorage.setItem('stryx.disperse-prefill', 'not json');
    expect(readAndClearDisprefill()).toBeNull();
  });

  it('treats a non-array payload as no prefill', () => {
    sessionStorage.setItem('stryx.disperse-prefill', JSON.stringify({ address: '0x1' }));
    expect(readAndClearDisprefill()).toBeNull();
  });

  it('drops any entry missing a string address instead of failing the whole read', () => {
    sessionStorage.setItem(
      'stryx.disperse-prefill',
      JSON.stringify([{ address: '0x1111111111111111111111111111111111111a', label: null }, { label: 'no address' }, { address: 5 }]),
    );
    expect(readAndClearDisprefill()).toEqual([{ address: '0x1111111111111111111111111111111111111a', label: null }]);
  });
});
