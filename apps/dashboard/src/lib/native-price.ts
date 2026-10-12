import { apiRequest } from './api';

export interface NativePriceReading {
  chainId: number;
  /**
   * Null when this chain has no price mapping (see the API's native-price.service.ts for why:
   * Robinhood Chain's native currency is named "ETH" but is not really Ethereum, so it is never priced
   * off Ethereum's real market price).
   */
  usdPerToken: number | null;
  fetchedAt: number;
  cached: boolean;
}

export function fetchNativePrice(chainId: number): Promise<NativePriceReading> {
  return apiRequest(`/chains/${chainId}/native-price`);
}

const USD_TOGGLE_KEY = 'stryx-mint-usd-toggle';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null;

function browserStorage(): StorageLike {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Whether the mint page's USD toggle is on, remembered per device (same pattern as the sidebar's pin). */
export function readUsdToggle(storage: StorageLike = browserStorage()): boolean {
  try {
    return storage?.getItem(USD_TOGGLE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeUsdToggle(on: boolean, storage: StorageLike = browserStorage()): void {
  try {
    storage?.setItem(USD_TOGGLE_KEY, on ? '1' : '0');
  } catch {
    // Private mode or quota: the toggle still works for this session, it just isn't remembered.
  }
}

/** `wei` (18 decimals) converted to a USD string at `usdPerToken`, or null if there is nothing to convert with. */
export function weiToUsd(wei: string, usdPerToken: number | null): string | null {
  if (usdPerToken === null) return null;
  const eth = Number(wei) / 1e18;
  if (!Number.isFinite(eth)) return null;
  const usd = eth * usdPerToken;
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
