import { apiRequest } from './api';
import type { Phase } from './collection-phases';

export type WalletEligibility = 'eligible' | 'not_eligible' | 'unknown';

/** One wallet's eligibility for one phase. */
export interface WalletEligibilityRow {
  walletId: string;
  address: string;
  balanceWei: string;
  minted: number;
  limit: number | null;
  remaining: number | null;
  eligible: WalletEligibility;
  reason?: string;
  priceWei: string | null;
  simulation?: { ok: true } | { ok: false; reason: string };
}

export interface PhaseEligibilityOutcome {
  preflightError?: 'unsupported_chain' | 'unsupported_mechanism' | 'missing_slug';
  detail?: string;
  results: WalletEligibilityRow[];
}

/** The most wallets the eligibility route takes in one request (apps/api mint-eligibility-controller.ts). */
export const ELIGIBILITY_BATCH = 100;

/** The client already holds `phase` and `slug`, so the server never re-fetches either. */
export async function checkPhaseEligibility(
  chainId: number,
  contract: string,
  body: { slug: string | null; walletIds: readonly string[]; phase: Phase },
): Promise<PhaseEligibilityOutcome> {
  const results: WalletEligibilityRow[] = [];
  for (let i = 0; i < body.walletIds.length; i += ELIGIBILITY_BATCH) {
    const part = await apiRequest<PhaseEligibilityOutcome>(`/chains/${chainId}/collections/${contract}/eligibility`, {
      method: 'POST',
      body: { ...body, walletIds: body.walletIds.slice(i, i + ELIGIBILITY_BATCH) },
    });
    // A reason the whole phase cannot be checked is the same for every wallet.
    if (part.preflightError) return part;
    results.push(...part.results);
  }
  return { results };
}

/** snake_case reasons from the API, as a short sentence start. Same convention as mint-ops.ts's humanReason. */
export function humanEligibilityReason(reason: string | undefined): string {
  if (!reason) return '';
  const text = reason.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
