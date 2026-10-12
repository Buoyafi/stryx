// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiRequest: apiRequestMock,
}));

import { fetchNativePrice, readUsdToggle, weiToUsd, writeUsdToggle } from '../src/lib/native-price';

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe('fetchNativePrice', () => {
  it('reads the per-chain native-price route', async () => {
    apiRequestMock.mockResolvedValueOnce({ chainId: 1, usdPerToken: 2738.82, fetchedAt: 1, cached: false });
    const reading = await fetchNativePrice(1);
    expect(apiRequestMock).toHaveBeenCalledWith('/chains/1/native-price');
    expect(reading.usdPerToken).toBe(2738.82);
  });
});

function fakeStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe('readUsdToggle / writeUsdToggle', () => {
  it('defaults to off', () => {
    expect(readUsdToggle(fakeStorage())).toBe(false);
  });

  it('round-trips true and false', () => {
    const storage = fakeStorage();
    writeUsdToggle(true, storage);
    expect(readUsdToggle(storage)).toBe(true);
    writeUsdToggle(false, storage);
    expect(readUsdToggle(storage)).toBe(false);
  });

  it('never throws when storage itself throws', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => readUsdToggle(throwing)).not.toThrow();
    expect(() => writeUsdToggle(true, throwing)).not.toThrow();
  });
});

describe('weiToUsd', () => {
  it('converts wei to a formatted USD string', () => {
    expect(weiToUsd((10n ** 16n).toString(), 2738.82)).toBe('$27.39'); // 0.01 ETH * $2738.82
  });

  it('returns null when there is no price to convert with', () => {
    expect(weiToUsd((10n ** 16n).toString(), null)).toBeNull();
  });

  it('shows "<$0.01" rather than "$0.00" for a genuinely tiny but non-zero amount', () => {
    expect(weiToUsd('1', 2738.82)).toBe('<$0.01');
  });

  it('shows exactly $0.00 for a genuinely zero price', () => {
    expect(weiToUsd('0', 2738.82)).toBe('$0.00');
  });
});
