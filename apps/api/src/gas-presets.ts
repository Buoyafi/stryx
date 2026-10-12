import { applyPriorityFee, type GasParameters } from '@stryx/transaction-engine';

/**
 * Pre-set gas for the signed-mint hot path, per chain, so nothing after the stage opens waits on
 * eth_estimateGas. The limit is a generous fixed ceiling; the fees are read once at warm-up.
 */
export interface GasPreset {
  /** Gas limit for a 1-token mint. */
  baseGasLimit: bigint;
  /** Added per extra token (ERC721A's per-token cost, with room). */
  perExtraTokenGas: bigint;
  /** The warm-up fee estimate is multiplied by this (as numerator / 100). */
  feeMultiplierPercent: bigint;
  /** Floor for maxFeePerGas, whatever the estimate says. */
  minMaxFeePerGasWei: bigint;
}

const DEFAULT_PRESET: GasPreset = {
  baseGasLimit: 400_000n,
  perExtraTokenGas: 40_000n,
  feeMultiplierPercent: 200n,
  minMaxFeePerGasWei: 100_000_000n, // 0.1 gwei
};

/** Only chains with a reason to differ from the default get an entry. */
const PRESETS: Partial<Record<number, GasPreset>> = {};

export function gasPresetFor(chainId: number): GasPreset {
  return PRESETS[chainId] ?? DEFAULT_PRESET;
}

export function gasLimitFor(preset: GasPreset, quantity: number): bigint {
  return preset.baseGasLimit + preset.perExtraTokenGas * BigInt(Math.max(0, quantity - 1));
}

/** Turns the one warm-up fee estimate into the fixed fees every send in the job uses. */
export function presetFees(
  preset: GasPreset,
  estimate: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  tip: { priorityFeeWei?: bigint | undefined; minPriorityFeeWei?: bigint | null | undefined } = {},
): Omit<GasParameters, 'gas'> {
  const padded = (estimate.maxFeePerGas * preset.feeMultiplierPercent) / 100n;
  const maxFeePerGas = padded > preset.minMaxFeePerGasWei ? padded : preset.minMaxFeePerGasWei;
  const maxPriorityFeePerGas = estimate.maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : estimate.maxPriorityFeePerGas;
  return applyPriorityFee({ maxFeePerGas, maxPriorityFeePerGas }, tip);
}
