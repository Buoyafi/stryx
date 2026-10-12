import { apiRequest } from './api';

export type PhaseKind = 'public' | 'allowlist';
export type PhaseSource = 'on-chain' | 'opensea';
/** Which of SeaDrop's three allow-list mechanisms this phase uses. */
export type AllowListMechanism = 'merkle' | 'signed' | 'token-gated' | 'unknown';

export interface Phase {
  id: string;
  name: string;
  kind: PhaseKind;
  priceWei: string | null;
  /** The ERC-20 the price is in, when it is not the chain's native token. */
  priceToken?: string;
  startMs: number | null;
  endMs: number | null;
  maxPerWallet: number | null;
  /** Which source supplied price, timing and limit: 'opensea' means not yet verified against the chain. */
  source: PhaseSource;
  mechanism: AllowListMechanism | null;
  /** OpenSea's own stage id: needed to send this exact phase back to POST .../eligibility. */
  openSeaStageUuid: string | null;
}

/** Whether OpenSea's side of the drop is in `phases`: fresh, stale (its last known stages), not listed, or unavailable. */
export type OpenSeaPhaseStatus = 'ok' | 'stale' | 'not_listed' | 'unavailable';

export interface CollectionPhasesResponse {
  chainId: number;
  contract: string;
  phases: Phase[];
  openSea?: OpenSeaPhaseStatus;
  /** When the stale stages were fetched (unix ms). */
  openSeaAsOf?: number;
}

export function fetchCollectionPhases(chainId: number, contract: string): Promise<CollectionPhasesResponse> {
  return apiRequest(`/chains/${chainId}/collections/${contract}/phases`);
}
