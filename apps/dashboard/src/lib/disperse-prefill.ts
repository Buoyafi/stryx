/**
 * A one-shot handoff from a bulk wallet generation to Disperse's recipient list, in sessionStorage: up
 * to 100 addresses would make an unwieldy URL.
 */

const KEY = 'stryx.disperse-prefill';

export interface DisprefillWallet {
  /** The wallet's id, so Disperse knows it is the same wallet its own picker lists. */
  id?: string;
  address: string;
  label: string | null;
}

export function writeDisprefill(wallets: readonly DisprefillWallet[]): void {
  sessionStorage.setItem(KEY, JSON.stringify(wallets));
}

/** Returns the pending prefill, if any, and clears it. Malformed or missing data is treated as none. */
export function readAndClearDisprefill(): DisprefillWallet[] | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  sessionStorage.removeItem(KEY);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (p): p is DisprefillWallet => typeof p === 'object' && p !== null && typeof (p as DisprefillWallet).address === 'string',
    );
  } catch {
    return null;
  }
}
