import type { Chain } from '@stryx/chains';

/** How a batch will be sent, and what it will cost. */
export type SendMode = 'contract' | 'sequential';
export type SourceKind = 'connected' | 'custodial';

/** A plain transfer to an ordinary account costs exactly this much gas. */
export const TRANSFER_GAS = 21_000n;
/** Used only when the wallet cannot estimate the contract call: deliberately generous, and labelled a rough guess. */
export const CONTRACT_BASE_GAS = 21_000n;
export const CONTRACT_GAS_PER_RECIPIENT = 30_000n;

export function chooseSendMode(input: { chain: Pick<Chain, 'disperseContract'>; sourceKind: SourceKind; contractVerified: boolean }): SendMode {
  if (input.sourceKind === 'custodial') return 'sequential';
  return input.chain.disperseContract && input.contractVerified ? 'contract' : 'sequential';
}

/** How many times a connected wallet will ask the user to sign. */
export function signatureCount(mode: SendMode, sourceKind: SourceKind, recipients: number): number {
  return sourceKind === 'connected' ? (mode === 'contract' ? 1 : recipients) : 0;
}

/** Shown BEFORE the review, when the user will have to sign more than once. Null when there is nothing to warn about. */
export function signatureWarning(mode: SendMode, sourceKind: SourceKind, recipients: number): string | null {
  const n = signatureCount(mode, sourceKind, recipients);
  return n > 1 ? `This chain sends one transaction per recipient. You'll sign ${n} times.` : null;
}

export interface GasEstimate {
  units: bigint;
  /** `estimated`: the wallet estimated the call. `exact`: plain transfers at 21,000 each. `rough`: a generous guess. */
  basis: 'estimated' | 'exact' | 'rough';
}

export function estimateGas(input: { mode: SendMode; recipients: number; walletEstimate?: bigint | undefined }): GasEstimate {
  if (input.mode === 'sequential') return { units: TRANSFER_GAS * BigInt(input.recipients), basis: 'exact' };
  if (input.walletEstimate !== undefined) return { units: input.walletEstimate, basis: 'estimated' };
  return { units: CONTRACT_BASE_GAS + CONTRACT_GAS_PER_RECIPIENT * BigInt(input.recipients), basis: 'rough' };
}

export interface ReviewNumbers {
  totalWei: bigint;
  gasUnits: bigint;
  /** Undefined when no gas price could be read: then cost and remaining balance are unknown, not guessed. */
  gasCostWei: bigint | undefined;
  remainingWei: bigint | undefined;
  /** False when the balance cannot cover the amount (plus gas, when the price is known). */
  enough: boolean;
}

export function reviewNumbers(input: { totalWei: bigint; gasUnits: bigint; gasPriceWei: bigint | undefined; balanceWei: bigint | undefined }): ReviewNumbers {
  const gasCostWei = input.gasPriceWei === undefined ? undefined : input.gasUnits * input.gasPriceWei;
  const remainingWei = input.balanceWei === undefined ? undefined : input.balanceWei - input.totalWei - (gasCostWei ?? 0n);
  const enough = input.balanceWei === undefined ? true : input.balanceWei >= input.totalWei + (gasCostWei ?? 0n);
  return { totalWei: input.totalWei, gasUnits: input.gasUnits, gasCostWei, remainingWei: gasCostWei === undefined ? undefined : remainingWei, enough };
}
