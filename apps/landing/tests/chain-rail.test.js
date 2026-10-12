import { describe, expect, it } from 'vitest';
import { CHAINS } from '@stryx/chains';
import { buildChainGridMarkup, mainnetCount } from '../src/lib/chain-rail.js';

// The real registry, not a fixture: the landing page must render exactly what the central table says.
const noIcon = { chainId: 9, name: 'Nova Chain', isTestnet: false, icon: null };

describe('buildChainGridMarkup', () => {
  const MAINNETS = CHAINS.filter((c) => !c.isTestnet);

  it('renders every registry mainnet as a button named after the chain', () => {
    const html = buildChainGridMarkup(CHAINS);
    for (const chain of MAINNETS) {
      expect(html).toContain(`data-chain-id="${chain.chainId}"`);
      expect(html).toContain(`aria-label="${chain.name}"`);
    }
  });

  it('renders one item per chain, with no <ul> wrapper (the page supplies the <ul>)', () => {
    const html = buildChainGridMarkup(CHAINS);
    expect(html.match(/<li class="chain-grid__item"/g)).toHaveLength(MAINNETS.length);
    expect(html.match(/<li class="chain-grid__item"/g)).toHaveLength(mainnetCount(CHAINS));
    expect(html).not.toContain('<ul');
  });

  it('renders real logos from local URLs for the registry chains, never a remote one', () => {
    const html = buildChainGridMarkup(CHAINS);
    expect(html).toContain('class="chain-icon__img"');
    expect(html).not.toMatch(/src="https?:\/\//);
  });

  it('leaves testnets off the public page entirely (no Robinhood testnet, no T badge)', () => {
    const html = buildChainGridMarkup(CHAINS);
    for (const chain of CHAINS.filter((c) => c.isTestnet)) expect(html).not.toContain(`data-chain-id="${chain.chainId}"`);
    expect(html).not.toContain('chain-icon__badge');
  });

  it('renders a lettered fallback (never an invented logo) for a chain with no icon', () => {
    const html = buildChainGridMarkup([noIcon]);
    expect(html).toContain('chain-icon__fallback');
    expect(html).toContain('>NO<');
    expect(html).not.toContain('<img');
  });

  it('carries the static status onto the dot, live by default and offline on request', () => {
    expect(buildChainGridMarkup(CHAINS)).toContain('chain-icon__dot--live');
    expect(buildChainGridMarkup(CHAINS, { status: 'offline' })).toContain('chain-icon__dot--offline');
  });

  it('does not put a tooltip in the grid: that lives in <body>', () => {
    expect(buildChainGridMarkup(CHAINS)).not.toContain('chain-tip');
  });

  it('escapes a chain name containing HTML-significant characters', () => {
    const html = buildChainGridMarkup([{ ...noIcon, name: '<script>alert(1)</script>' }]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('mainnetCount', () => {
  it('counts the registry\'s real networks and leaves testnets out', () => {
    expect(mainnetCount(CHAINS)).toBe(CHAINS.filter((c) => !c.isTestnet).length);
    expect(mainnetCount(CHAINS)).toBeLessThan(CHAINS.length);
    expect(mainnetCount([noIcon, { ...noIcon, chainId: 10, isTestnet: true }])).toBe(1);
  });
});
