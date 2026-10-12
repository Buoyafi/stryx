import { chainById } from '@stryx/chains';

/** Client-side mirror of apps/api/src/priority-fee.ts, so the mint page can say what is wrong before anything is sent. */
export const MAX_PRIORITY_FEE_GWEI = 500;
/** A mint's typical gas, only for the "at most about" hint beside the tip field. */
export const TYPICAL_MINT_GAS = 200_000;

/** Whether this chain gets a tip setting at all (see FeeMarket in @stryx/chains). */
export function tipSettingShown(chainId: number): boolean {
  return chainById(chainId)?.feeMarket.tipAffectsOrdering ?? false;
}

/** Null when `gwei` is fine to send (blank included), else a plain sentence. */
export function priorityFeeProblem(chainId: number, gwei: string): string | null {
  const v = gwei.trim();
  if (v === '') return null;
  if (!/^\d+(\.\d{1,9})?$/.test(v)) return 'Priority fee must be a number of gwei, e.g. 2 or 1.5.';
  const n = Number(v);
  if (n > MAX_PRIORITY_FEE_GWEI) return `Priority fee above ${MAX_PRIORITY_FEE_GWEI} gwei is almost certainly a typo.`;
  const floor = chainById(chainId)?.feeMarket.minPriorityFeeGwei ?? null;
  if (floor !== null && n < floor) return `${chainById(chainId)?.name ?? 'This chain'} requires at least ${floor} gwei.`;
  return null;
}

/** The request field: omitted when blank, so the server uses the network's suggestion. */
export function priorityFeeBody(gwei: string): { priorityFeeGwei?: string } {
  const v = gwei.trim();
  return v === '' ? {} : { priorityFeeGwei: v };
}

/** "≈ 0.0004 ETH per mint at most" for a tip, at a typical mint's gas. */
export function tipCostHint(gwei: string, symbol: string): string | null {
  const v = gwei.trim();
  if (v === '' || !/^\d+(\.\d{1,9})?$/.test(v)) return null;
  const native = (Number(v) * TYPICAL_MINT_GAS) / 1e9;
  if (native === 0) return null;
  return `adds up to about ${native < 0.0001 ? native.toExponential(1) : Number(native.toPrecision(2))} ${symbol} per mint`;
}
