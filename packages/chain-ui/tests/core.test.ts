import { describe, expect, it } from 'vitest';
import { CHAINS } from '@stryx/chains';
import { chainInitials, computeTooltipPosition, tooltipModel, viewForChainId, type ChainView } from '../src/core.js';

describe('viewForChainId', () => {
  it('returns the registry entry for a known chain', () => {
    expect(viewForChainId(8453)).toMatchObject({ chainId: 8453, name: 'Base', isTestnet: false });
  });

  it('returns a bare, fallback-icon view for a chain the registry does not list', () => {
    expect(viewForChainId(999999)).toEqual({ chainId: 999999, name: 'Chain 999999', isTestnet: false, icon: null });
    expect(viewForChainId(999999, 'Somechain').name).toBe('Somechain');
  });
});

describe('chainInitials', () => {
  it('is the first two letters, upper-cased', () => {
    expect(chainInitials('Robinhood Chain')).toBe('RO');
    expect(chainInitials('base')).toBe('BA');
  });

  it('skips spaces, digits and symbols, and never returns an empty badge', () => {
    expect(chainInitials('0x Chain')).toBe('XC');
    expect(chainInitials('1234')).toBe('?');
    expect(chainInitials('')).toBe('?');
  });
});

describe('tooltipModel', () => {
  const robinhoodTestnet = CHAINS.find((c) => c.chainId === 46630)!;

  it('shows name, chain id, network kind and gas token', () => {
    expect(tooltipModel(robinhoodTestnet)).toEqual({
      title: 'Robinhood Chain Testnet',
      rows: [
        { label: 'Chain ID', value: '46630' },
        { label: 'Network', value: 'Testnet' },
        { label: 'Gas token', value: 'ETH' },
      ],
    });
  });

  it('says Mainnet for a mainnet, and POL for Polygon', () => {
    const polygon = tooltipModel(CHAINS.find((c) => c.chainId === 137)!);
    expect(polygon.rows).toContainEqual({ label: 'Network', value: 'Mainnet' });
    expect(polygon.rows).toContainEqual({ label: 'Gas token', value: 'POL' });
  });

  it('omits the gas row when the chain has no known gas token, instead of guessing', () => {
    const unknown: ChainView = { chainId: 5, name: 'Mystery', isTestnet: false, icon: null };
    expect(tooltipModel(unknown).rows.map((r) => r.label)).toEqual(['Chain ID', 'Network']);
  });

  it('appends caller rows after the static ones, keeping their tone', () => {
    const model = tooltipModel(robinhoodTestnet, [{ label: 'RPC', value: 'error', tone: 'fail' }]);
    expect(model.rows.at(-1)).toEqual({ label: 'RPC', value: 'error', tone: 'fail' });
    expect(model.rows).toHaveLength(4);
  });
});

describe('computeTooltipPosition', () => {
  const viewport = { width: 1000, height: 800 };
  const tip = { width: 200, height: 80 };
  const anchor = (left: number, top: number) => ({ left, top, right: left + 56, bottom: top + 56 });

  it('sits above and centred when there is room', () => {
    const p = computeTooltipPosition({ anchor: anchor(472, 400), tip, viewport });
    expect(p.placement).toBe('top');
    expect(p.top).toBe(400 - 10 - 80);
    expect(p.left).toBe(500 - 100);
  });

  it('flips below when there is no room above', () => {
    const p = computeTooltipPosition({ anchor: anchor(472, 20), tip, viewport });
    expect(p.placement).toBe('bottom');
    expect(p.top).toBe(76 + 10);
  });

  it('clamps to the left and right viewport edges', () => {
    expect(computeTooltipPosition({ anchor: anchor(0, 400), tip, viewport }).left).toBe(8);
    expect(computeTooltipPosition({ anchor: anchor(960, 400), tip, viewport }).left).toBe(1000 - 8 - 200);
  });

  it('keeps the arrow pointing at the anchor and inside the tooltip', () => {
    const near = computeTooltipPosition({ anchor: anchor(0, 400), tip, viewport });
    expect(near.arrowX).toBeGreaterThanOrEqual(14);
    expect(near.arrowX).toBeLessThanOrEqual(200 - 14);
    const centred = computeTooltipPosition({ anchor: anchor(472, 400), tip, viewport });
    expect(centred.arrowX).toBe(100);
  });

  it('never returns a negative left, even on a viewport narrower than the tooltip', () => {
    const p = computeTooltipPosition({ anchor: anchor(10, 400), tip: { width: 400, height: 80 }, viewport: { width: 360, height: 800 } });
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
});
