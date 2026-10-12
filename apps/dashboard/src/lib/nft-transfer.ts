import { apiRequest } from './api';

export type NftStandard = 'erc721' | 'erc1155';

export interface NftHolding {
  contract: string;
  tokenId: string;
  standard: NftStandard;
  amount: string;
  name?: string;
  imageUrl?: string;
}

export interface HoldingsResult {
  walletId: string;
  chainId: number;
  /**
   * Which source answered: 'ledger' means "tokens minted through Stryx only," a real, honest degraded
   * state shown to the operator, never presented as a complete answer.
   */
  source: 'alchemy' | 'ledger';
  holdings: NftHolding[];
}

export function fetchHoldings(walletId: string, chainId: number): Promise<HoldingsResult> {
  return apiRequest<HoldingsResult>(`/wallets/${walletId}/nfts?chainId=${chainId}`);
}

export interface NftTransferItemInput {
  walletId: string;
  contract: string;
  tokenId: string;
  standard: NftStandard;
  amount: string;
}

export interface NftTransferResultRow {
  walletId: string;
  contract: string;
  tokenId: string;
  standard: NftStandard;
  /** 'unknown': it may have gone out. The row carries the hash to check before sending again. */
  status: 'sent' | 'skipped' | 'failed' | 'unknown';
  hash?: `0x${string}`;
  nonce?: number;
  error?: string;
}

export interface NftTransferOutcome {
  ok: boolean;
  preflightError?: string;
  haltReason?: string;
  detail?: string;
  results: NftTransferResultRow[];
}

export function transferNfts(chainId: number, destination: string, items: readonly NftTransferItemInput[]): Promise<NftTransferOutcome> {
  return apiRequest<NftTransferOutcome>('/wallets/nfts/transfer', { method: 'POST', body: { chainId, destination, items } });
}

/** Stable key for a selected token, independent of which wallet screen it was picked from. */
export const tokenKey = (item: Pick<NftTransferItemInput, 'walletId' | 'contract' | 'tokenId'>): string =>
  `${item.walletId}:${item.contract.toLowerCase()}:${item.tokenId}`;
