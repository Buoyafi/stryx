import { withRetry, isFetchTransportFailure } from '@stryx/utils';
import type { FetchLike } from './opensea-resolver.js';

/**
 * One mint stage as OpenSea reports it: richer than the chain for an allow-list stage, whose price,
 * timing and limit live in wallets' leaves.
 */
export interface OpenSeaStageInfo {
  stageType: string;
  label: string;
  priceWei: string | null;
  /** The ERC-20 the price is in, when it is not the chain's native token. `priceWei` is then in that token's units. */
  priceToken?: string;
  startTime: string | null;
  endTime: string | null;
  maxPerWallet: number | null;
  allowlistWalletCount: number | null;
  /** OpenSea's own stage identifier. */
  uuid: string | null;
}

export interface OpenSeaDropInfo {
  collectionSlug: string;
  collectionName: string;
  imageUrl: string | null;
  openSeaUrl: string | null;
  totalSupply: number | null;
  maxSupply: number | null;
  stages: OpenSeaStageInfo[];
}

/**
 * Best-effort enrichment of an on-chain drop with what OpenSea knows: name, image, supply, and
 * per-stage price, timing and limits. Never throws; null when there is nothing.
 */
export async function fetchOpenSeaDropInfo(
  fetchImpl: FetchLike,
  apiKey: string | undefined,
  openSeaChainName: string,
  contract: string,
  apiBase = 'https://api.opensea.io',
): Promise<OpenSeaDropInfo | null> {
  const result = await fetchOpenSeaDropInfoResult(fetchImpl, apiKey, openSeaChainName, contract, apiBase);
  return result.status === 'ok' ? result.info : null;
}

/**
 * Why there is or is not drop info. "OpenSea does not list this collection" is an answer; "OpenSea
 * could not be reached" is not.
 */
export type DropInfoResult =
  | { status: 'ok'; info: OpenSeaDropInfo }
  | { status: 'not_listed' }
  | { status: 'unavailable'; detail: string };

/** Transport failures get this many attempts in total, this far apart. */
const DROP_INFO_ATTEMPTS = 3;
const DROP_INFO_RETRY_DELAY_MS = 400;

export async function fetchOpenSeaDropInfoResult(
  fetchImpl: FetchLike,
  apiKey: string | undefined,
  openSeaChainName: string,
  contract: string,
  apiBase = 'https://api.opensea.io',
): Promise<DropInfoResult> {
  if (!apiKey) return { status: 'not_listed' };
  const get = (url: string) =>
    withRetry(() => fetchImpl(url, { headers: { accept: 'application/json', 'x-api-key': apiKey } }), {
      attempts: DROP_INFO_ATTEMPTS,
      delayMs: DROP_INFO_RETRY_DELAY_MS,
      isRetryable: isFetchTransportFailure,
    });
  // 404 is OpenSea's answer ("not here"); anything else that is not 2xx (429, 5xx) is it failing to answer.
  const unavailable = (what: string, status: number): DropInfoResult => ({ status: 'unavailable', detail: `${what} returned ${status}` });

  try {
    const contractRes = await get(`${apiBase}/api/v2/chain/${encodeURIComponent(openSeaChainName)}/contract/${contract}`);
    if (contractRes.status === 404 || contractRes.status === 400) return { status: 'not_listed' };
    if (!contractRes.ok) return unavailable('contract lookup', contractRes.status);
    const contractBody = (await contractRes.json()) as { collection?: unknown };
    const slug = contractBody.collection;
    if (typeof slug !== 'string' || slug.length === 0) return { status: 'not_listed' };

    const dropRes = await get(`${apiBase}/api/v2/drops/${encodeURIComponent(slug)}`);
    if (dropRes.status === 404) return { status: 'not_listed' };
    if (!dropRes.ok) return unavailable('drop lookup', dropRes.status);
    const drop = (await dropRes.json()) as Record<string, unknown>;

    const stages = parseDropStages(drop);

    const collectionName = str(drop['collection_name']);
    if (!collectionName) return { status: 'not_listed' }; // the one field genuinely required for this to be useful at all

    return {
      status: 'ok',
      info: {
        collectionSlug: slug,
        collectionName,
        imageUrl: str(drop['image_url']),
        openSeaUrl: str(drop['opensea_url']),
        totalSupply: numOrNull(drop['total_supply']),
        maxSupply: numOrNull(drop['max_supply']),
        stages,
      },
    };
  } catch (err) {
    return { status: 'unavailable', detail: isFetchTransportFailure(err) ? 'could not reach OpenSea' : err instanceof Error ? err.message : String(err) };
  }
}

/** The `stages` array of a GET /api/v2/drops/{slug} response, parsed defensively. */
export function parseDropStages(drop: Record<string, unknown>): OpenSeaStageInfo[] {
  const rawStages = Array.isArray(drop['stages']) ? (drop['stages'] as unknown[]) : [];
  return rawStages
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({
      stageType: str(s['stage_type']) ?? 'unknown',
      label: str(s['label']) ?? str(s['stage_type']) ?? 'Stage',
      priceWei: str(s['price']),
      ...tokenOf(s['price_currency_address']),
      startTime: str(s['start_time']),
      endTime: str(s['end_time']),
      maxPerWallet: numOrNull(s['max_per_wallet']),
      allowlistWalletCount: numOrNull(s['allowlist_wallet_count']),
      uuid: str(s['uuid']),
    }));
}

function tokenOf(v: unknown): { priceToken?: string } {
  const address = str(v);
  return address && !/^0x0{40}$/i.test(address) ? { priceToken: address } : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
