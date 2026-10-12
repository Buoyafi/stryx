import { chainById } from '@stryx/chains';

/** A sign-in message may name any chain this platform knows. For an EOA it is informational only (ADR-003 §4.1). */
export function isSupportedChainId(chainId: number): boolean {
  return Number.isInteger(chainId) && chainById(chainId) !== undefined;
}
