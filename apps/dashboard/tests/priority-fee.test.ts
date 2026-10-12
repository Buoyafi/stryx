import { describe, expect, it } from 'vitest';
import { priorityFeeBody, priorityFeeProblem, tipCostHint, tipSettingShown } from '../src/lib/priority-fee';

describe('priority fee helpers', () => {
  it('shown only where the tip orders transactions', () => {
    expect(tipSettingShown(1)).toBe(true);
    expect(tipSettingShown(8453)).toBe(true);
    expect(tipSettingShown(137)).toBe(true);
    expect(tipSettingShown(42161)).toBe(false);
    expect(tipSettingShown(4663)).toBe(false);
  });

  it('problems: format, typo ceiling, chain minimum; blank is fine', () => {
    expect(priorityFeeProblem(1, '')).toBeNull();
    expect(priorityFeeProblem(1, '2.5')).toBeNull();
    expect(priorityFeeProblem(1, 'abc')).toMatch(/number of gwei/);
    expect(priorityFeeProblem(1, '501')).toMatch(/typo/);
    expect(priorityFeeProblem(137, '24')).toMatch(/at least 25/);
    expect(priorityFeeProblem(137, '25')).toBeNull();
  });

  it('body omits a blank tip and trims a set one', () => {
    expect(priorityFeeBody('  ')).toEqual({});
    expect(priorityFeeBody(' 3 ')).toEqual({ priorityFeeGwei: '3' });
  });

  it('cost hint at a typical mint gas', () => {
    expect(tipCostHint('2', 'ETH')).toBe('adds up to about 0.0004 ETH per mint');
    expect(tipCostHint('', 'ETH')).toBeNull();
  });
});
