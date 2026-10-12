import { describe, expect, it } from 'vitest';
import { CHAINS } from '@stryx/chains';
import { iconParts, iconUrl } from '../src/icons.js';

describe('icon resolution', () => {
  it('resolves every registry icon to a bundled local asset', () => {
    for (const chain of CHAINS.filter((c) => c.icon !== null)) {
      const url = iconUrl(chain.icon);
      expect(url, chain.name).not.toBeNull();
      expect(url, chain.name).not.toMatch(/^https?:\/\//); // never a remote URL
    }
  });

  it('every chain has a logo: none falls back to the lettered badge', () => {
    for (const chain of CHAINS) expect(iconUrl(chain.icon), chain.name).not.toBeNull();
  });

  it('returns null for a chain with no icon, and for an icon path that is not bundled', () => {
    expect(iconUrl(null)).toBeNull();
    expect(iconUrl('icons/does-not-exist.svg')).toBeNull();
  });

  it('gives the testnet its mainnet\'s logo plus the badge, and a mainnet no badge', () => {
    const mainnet = iconParts(CHAINS.find((c) => c.chainId === 4663)!);
    const testnet = iconParts(CHAINS.find((c) => c.chainId === 46630)!);
    expect(testnet.url).toBe(mainnet.url);
    expect(testnet.showTestnetBadge).toBe(true);
    expect(mainnet.showTestnetBadge).toBe(false);
  });

  it('falls back to two-letter initials when there is no logo', () => {
    const parts = iconParts({ chainId: 9, name: 'Nova Chain', isTestnet: false, icon: null });
    expect(parts).toEqual({ url: null, initials: 'NO', showTestnetBadge: false });
  });
});
