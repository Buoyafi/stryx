import { z } from 'zod';
import { parseGwei } from 'viem';
import { chainById } from '@stryx/chains';

/** The operator's chosen priority fee (tip), in gwei, as typed. */
export const PriorityFeeGweiField = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,9})?$/, 'priority fee must be a number of gwei, e.g. "2" or "1.5"')
  .optional();

/** A ceiling against a typo, not a policy: 500 gwei is already far above what a contested mint needs. */
export const MAX_PRIORITY_FEE_GWEI = 500;

export type PriorityFeeResolution = { ok: true; priorityFeeWei: string | undefined } | { ok: false; message: string };

/** Validates a chosen tip against the chain it will be paid on. */
export function resolvePriorityFee(chainId: number, gwei: string | undefined): PriorityFeeResolution {
  if (gwei === undefined || gwei === '') return { ok: true, priorityFeeWei: undefined };
  const chain = chainById(chainId);
  if (!chain) return { ok: false, message: `Unknown chain ${chainId}.` };
  if (!chain.feeMarket.tipAffectsOrdering) {
    return { ok: false, message: `A priority fee has no effect on ${chain.name}: its sequencer takes transactions in arrival order. Leave it blank.` };
  }
  if (Number(gwei) > MAX_PRIORITY_FEE_GWEI) return { ok: false, message: `Priority fee ${gwei} gwei is above the ${MAX_PRIORITY_FEE_GWEI} gwei limit.` };
  const wei = parseGwei(gwei);
  const floor = chain.feeMarket.minPriorityFeeGwei;
  if (floor !== null && wei < parseGwei(String(floor))) {
    return { ok: false, message: `${chain.name} requires at least ${floor} gwei; leave it blank to use the network's suggestion (never below ${floor}).` };
  }
  return { ok: true, priorityFeeWei: wei.toString() };
}
