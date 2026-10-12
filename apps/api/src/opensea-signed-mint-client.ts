import { isFetchTransportFailure } from '@stryx/utils';
import { extractCalldata } from './opensea-drop-client.js';
import { parseDropStages, type OpenSeaStageInfo } from './opensea-drop-info.js';

/** The fetch surface this client needs. */
export type HeaderFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; headers: { get(name: string): string | null } }>;

/** One answer from `POST /api/v2/drops/{slug}/mint`, classified. Returned, never thrown: the runner branches on every outcome. */
export type MintCalldataAnswer =
  | { kind: 'calldata'; calldata: `0x${string}`; /** The contract OpenSea's transaction targets, when it says. */ to: string | null }
  | { kind: 'not_active'; message: string }
  | { kind: 'not_eligible'; message: string }
  | { kind: 'insufficient_funds'; message: string }
  | { kind: 'rate_limited'; retryAfterMs: number | null }
  | { kind: 'error'; status: number | null; message: string };

/**
 * Reads a 422 "not eligible" message for the stage OpenSea says is active: OpenSea judges eligibility
 * against whichever stage is active now.
 */
export function activeStageInIneligibleMessage(message: string): { mentionsActiveStage: boolean; activeStage: string | null } {
  const hit = /active\s+(?:drop\s+)?stage/i.exec(message);
  if (!hit) return { mentionsActiveStage: false, activeStage: null };
  const rest = message.slice(hit.index + hit[0].length).replace(/^[\s.:,;-]+/, '');
  const quotes = `'"\u2018\u2019\u201c\u201d\``;
  let name: string;
  if (rest.length > 0 && quotes.includes(rest[0]!)) {
    const close = [...rest.slice(1)].findIndex((ch) => quotes.includes(ch));
    name = close === -1 ? '' : rest.slice(1, 1 + close);
  } else {
    name = /^[^(:,.;\n]*/.exec(rest)![0].replace(/\s+(is|has|was)\b.*$/i, '');
  }
  name = name.trim();
  return { mentionsActiveStage: true, activeStage: name.length > 0 && name.length <= 60 ? name : null };
}

/** True when a "not eligible" message is about a different stage than `stageLabel`. */
export function ineligibleForAnotherStage(message: string, stageLabel: string): { other: boolean; activeStage: string | null } {
  const { mentionsActiveStage, activeStage } = activeStageInIneligibleMessage(message);
  if (!mentionsActiveStage) return { other: false, activeStage: null };
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
  if (activeStage !== null) return { other: norm(activeStage) !== norm(stageLabel), activeStage };
  return { other: !norm(message).includes(norm(stageLabel)), activeStage: null };
}

export interface DropStagesSnapshot {
  stages: OpenSeaStageInfo[];
  /** OpenSea's own `Date` response header, parsed (whole-second resolution), or null. */
  serverDateMs: number | null;
  /** Local clock at the midpoint of the request, for comparing against `serverDateMs`. */
  localMidpointMs: number;
  roundTripMs: number;
}

/**
 * The two documented OpenSea endpoints the signed-mint path uses: `GET /api/v2/drops/{slug}` for the
 * stages, and `POST /api/v2/drops/{slug}/mint` for the calldata.
 */
export class OpenSeaSignedMintClient {
  constructor(
    private readonly fetchImpl: HeaderFetch,
    private readonly apiKey: string | undefined,
    private readonly apiBase = 'https://api.opensea.io',
    private readonly now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  /** One attempt, no retry of its own: the caller owns the retry loop and its pacing. */
  async requestMintCalldata(slug: string, minter: `0x${string}`, quantity: number, signal?: AbortSignal): Promise<MintCalldataAnswer> {
    if (!this.apiKey) return { kind: 'error', status: null, message: 'OPENSEA_API_KEY is not set.' };

    let res: Awaited<ReturnType<HeaderFetch>>;
    try {
      res = await this.fetchImpl(`${this.apiBase}/api/v2/drops/${encodeURIComponent(slug)}/mint`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify({ minter, quantity }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      return {
        kind: 'error',
        status: null,
        message: isFetchTransportFailure(err) ? 'Could not reach OpenSea.' : err instanceof Error ? err.message : String(err),
      };
    }

    if (res.status === 429) return { kind: 'rate_limited', retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()) };

    if (!res.ok) {
      const message = await firstErrorMessage(res);
      if (res.status === 409) return { kind: 'not_active', message: message ?? 'Drop is not currently active for minting.' };
      if (res.status === 422) {
        if (message && /insufficient balance/i.test(message)) return { kind: 'insufficient_funds', message };
        return { kind: 'not_eligible', message: message ?? 'Wallet is not eligible for this stage.' };
      }
      return { kind: 'error', status: res.status, message: message ?? `OpenSea returned ${res.status}.` };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'error', status: res.status, message: 'OpenSea returned a response that is not JSON.' };
    }
    const calldata = extractCalldata(body);
    if (!calldata) return { kind: 'error', status: res.status, message: 'OpenSea mint response had no recognizable calldata.' };
    return { kind: 'calldata', calldata, to: extractTarget(body) };
  }

  /** The drop's stages plus timing data for the clock check. Throws on anything but a 2xx. */
  async getDropStages(slug: string): Promise<DropStagesSnapshot> {
    if (!this.apiKey) throw new Error('OPENSEA_API_KEY is not set.');
    const sent = this.now();
    const res = await this.fetchImpl(`${this.apiBase}/api/v2/drops/${encodeURIComponent(slug)}`, {
      headers: { accept: 'application/json', 'x-api-key': this.apiKey },
    });
    const received = this.now();
    if (!res.ok) throw new Error(`OpenSea drops API returned ${res.status} for "${slug}".`);
    const body = (await res.json()) as unknown;
    if (typeof body !== 'object' || body === null) throw new Error('OpenSea drops API returned a non-object body.');

    const dateHeader = res.headers.get('date');
    const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
    return {
      stages: parseDropStages(body as Record<string, unknown>),
      serverDateMs: Number.isNaN(parsedDate) ? null : parsedDate,
      localMidpointMs: Math.round((sent + received) / 2),
      roundTripMs: received - sent,
    };
  }
}

/** `transaction.to` (or `tx.to`) from the mint response, if present and address-shaped. */
function extractTarget(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  for (const holder of [b['transaction'], b['tx']]) {
    const to = (holder as Record<string, unknown> | undefined)?.['to'];
    if (typeof to === 'string' && /^0x[0-9a-fA-F]{40}$/.test(to)) return to;
  }
  return null;
}

/** `Retry-After` is either delay-seconds or an HTTP date (RFC 9110). Null when absent or unparseable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

async function firstErrorMessage(res: { json: () => Promise<unknown> }): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    if (typeof body !== 'object' || body === null) return undefined;
    const errors = (body as Record<string, unknown>)['errors'];
    const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
    return typeof first === 'string' ? first : undefined;
  } catch {
    return undefined;
  }
}
