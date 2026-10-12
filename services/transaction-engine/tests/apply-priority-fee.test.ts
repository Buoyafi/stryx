import { describe, expect, it } from 'vitest';
import { applyPriorityFee } from '../src/service/gas-estimator.service.js';

const gwei = (n: number) => BigInt(Math.round(n * 1e9));
// A node's suggestion: padded base part 30 gwei + suggested tip 1 gwei.
const suggested = { maxFeePerGas: gwei(31), maxPriorityFeePerGas: gwei(1) };

describe('applyPriorityFee', () => {
  it('no tip, no floor: the suggestion unchanged', () => {
    expect(applyPriorityFee(suggested, {})).toEqual(suggested);
  });

  it('a chosen tip replaces the suggested tip and keeps the base part', () => {
    expect(applyPriorityFee(suggested, { priorityFeeWei: gwei(5) })).toEqual({ maxFeePerGas: gwei(35), maxPriorityFeePerGas: gwei(5) });
  });

  it('a chosen tip below the suggestion lowers both', () => {
    expect(applyPriorityFee(suggested, { priorityFeeWei: gwei(0.5) })).toEqual({ maxFeePerGas: gwei(30.5), maxPriorityFeePerGas: gwei(0.5) });
  });

  it("the chain's floor raises a low suggestion (Polygon: 25 gwei)", () => {
    expect(applyPriorityFee(suggested, { minPriorityFeeWei: gwei(25) })).toEqual({ maxFeePerGas: gwei(55), maxPriorityFeePerGas: gwei(25) });
  });

  it("the floor also raises a chosen tip below it, and leaves one above it alone", () => {
    expect(applyPriorityFee(suggested, { priorityFeeWei: gwei(10), minPriorityFeeWei: gwei(25) }).maxPriorityFeePerGas).toBe(gwei(25));
    expect(applyPriorityFee(suggested, { priorityFeeWei: gwei(40), minPriorityFeeWei: gwei(25) })).toEqual({ maxFeePerGas: gwei(70), maxPriorityFeePerGas: gwei(40) });
  });

  it('a suggestion whose maxFee is below its own tip keeps no negative base part', () => {
    expect(applyPriorityFee({ maxFeePerGas: gwei(1), maxPriorityFeePerGas: gwei(2) }, { priorityFeeWei: gwei(3) })).toEqual({ maxFeePerGas: gwei(3), maxPriorityFeePerGas: gwei(3) });
  });
});
