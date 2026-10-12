import { describe, expect, it } from 'vitest';
import { MAX_PRIORITY_FEE_GWEI, PriorityFeeGweiField, resolvePriorityFee } from '../src/priority-fee.js';
import { presetFees, gasPresetFor } from '../src/gas-presets.js';

describe('resolvePriorityFee', () => {
  it('blank means the network suggestion', () => {
    expect(resolvePriorityFee(1, undefined)).toEqual({ ok: true, priorityFeeWei: undefined });
    expect(resolvePriorityFee(1, '')).toEqual({ ok: true, priorityFeeWei: undefined });
  });

  it('converts gwei to a wei string on chains where the tip orders transactions', () => {
    expect(resolvePriorityFee(1, '2')).toEqual({ ok: true, priorityFeeWei: '2000000000' });
    expect(resolvePriorityFee(8453, '0.05')).toEqual({ ok: true, priorityFeeWei: '50000000' });
  });

  it('refuses a tip on first-come-first-served chains (Arbitrum One, Robinhood)', () => {
    const arb = resolvePriorityFee(42161, '2');
    expect(arb.ok).toBe(false);
    expect(!arb.ok && arb.message).toMatch(/no effect on Arbitrum One/);
    expect(resolvePriorityFee(4663, '1').ok).toBe(false);
    expect(resolvePriorityFee(4663, undefined).ok).toBe(true);
  });

  it("refuses a tip under the chain's own minimum and above the typo ceiling", () => {
    expect(resolvePriorityFee(137, '10').ok).toBe(false);
    expect(resolvePriorityFee(137, '30')).toEqual({ ok: true, priorityFeeWei: '30000000000' });
    expect(resolvePriorityFee(1, String(MAX_PRIORITY_FEE_GWEI + 1)).ok).toBe(false);
  });

  it('the input field accepts plain decimals only', () => {
    expect(PriorityFeeGweiField.safeParse('1.5').success).toBe(true);
    expect(PriorityFeeGweiField.safeParse('-1').success).toBe(false);
    expect(PriorityFeeGweiField.safeParse('1e9').success).toBe(false);
    expect(PriorityFeeGweiField.safeParse(undefined).success).toBe(true);
  });
});

describe('presetFees with a tip (signed mints)', () => {
  const preset = gasPresetFor(1);
  const estimate = { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

  it('unchanged without a tip or floor', () => {
    expect(presetFees(preset, estimate)).toEqual({ maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  });

  it('swaps in the chosen tip over the padded base part', () => {
    expect(presetFees(preset, estimate, { priorityFeeWei: 5_000_000_000n })).toEqual({ maxFeePerGas: 24_000_000_000n, maxPriorityFeePerGas: 5_000_000_000n });
  });

  it("raises to the chain's minimum", () => {
    expect(presetFees(preset, estimate, { minPriorityFeeWei: 25_000_000_000n }).maxPriorityFeePerGas).toBe(25_000_000_000n);
  });
});
