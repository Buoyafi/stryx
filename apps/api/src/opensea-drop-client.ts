import { decodeFunctionData } from 'viem';
import { withRetry, isFetchTransportFailure, describeFetchFailure } from '@stryx/utils';
import { SEADROP_ABI, type MintParams } from '@stryx/nft-engine';
import type { FetchLike } from './opensea-resolver.js';

/** The pieces taken from OpenSea's ready-to-sign mint transaction, so the transaction can be rebuilt here. */
export interface OpenSeaAllowListData {
  mintParams: MintParams;
  proof: readonly `0x${string}`[];
}

/** The one method MintExecutionService calls, as an interface, so a caching wrapper can stand in. */
export interface OpenSeaProofFetcher {
  fetchAllowListData(slug: string, minter: `0x${string}`, quantity: number): Promise<OpenSeaAllowListData>;
}

export class OpenSeaDropError extends Error {
  public readonly code:
    | 'not_eligible'
    | 'insufficient_funds'
    | 'not_active'
    | 'not_found'
    | 'bad_response'
    | 'not_seadrop'
    | 'no_api_key'
    | 'network_unavailable';
  constructor(code: OpenSeaDropError['code'], message: string) {
    super(message);
    this.name = 'OpenSeaDropError';
    this.code = code;
  }
}

/**
 * Fetches allow-list proof data for a wallet from OpenSea's Drops API by requesting the ready-to-sign
 * mint transaction and decoding it. Nothing from OpenSea is ever signed.
 */
export class OpenSeaDropClient implements OpenSeaProofFetcher {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly apiKey: string | undefined,
    private readonly apiBase = 'https://api.opensea.io',
  ) {}

  async fetchAllowListData(slug: string, minter: `0x${string}`, quantity: number): Promise<OpenSeaAllowListData> {
    if (!this.apiKey) {
      throw new OpenSeaDropError('no_api_key', 'OpenSea proof fetching requires OPENSEA_API_KEY.');
    }

    // A network failure of the fetch itself is turned into a typed error, like an HTTP error is.
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await withRetry(
        () =>
          this.fetchImpl(`${this.apiBase}/api/v2/drops/${encodeURIComponent(slug)}/mint`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': this.apiKey! },
            body: JSON.stringify({ minter, quantity }),
          }),
        { attempts: 2, delayMs: 300, isRetryable: isFetchTransportFailure },
      );
    } catch (err) {
      if (isFetchTransportFailure(err)) {
        throw new OpenSeaDropError('network_unavailable', `Could not reach OpenSea (${describeFetchFailure(err)}). Usually transient: try again in a moment.`);
      }
      throw err;
    }

    // Map OpenSea's documented status codes to typed errors.
    if (!res.ok) {
      const message = await firstErrorMessage(res);
      if (res.status === 404) throw new OpenSeaDropError('not_found', message ?? `OpenSea has no drop for slug "${slug}".`);
      if (res.status === 409) throw new OpenSeaDropError('not_active', message ?? 'Drop is not currently active for minting.');
      if (res.status === 422) {
        // "Insufficient funds" only when OpenSea's own message says so; any other 422 is "not
        // eligible".
        if (message && /insufficient balance/i.test(message)) {
          throw new OpenSeaDropError('insufficient_funds', message);
        }
        throw new OpenSeaDropError('not_eligible', message ?? 'Wallet is not eligible (not on allowlist or limit exceeded).');
      }
      throw new OpenSeaDropError('bad_response', message ? `OpenSea drops API returned ${res.status}: ${message}` : `OpenSea drops API returned ${res.status}.`);
    }

    const body = (await res.json()) as unknown;
    const calldata = extractCalldata(body);
    if (!calldata) {
      throw new OpenSeaDropError('bad_response', 'OpenSea mint response did not contain recognizable transaction calldata.');
    }

    return decodeAllowListCalldata(calldata);
  }
}

/** OpenSea's error responses are shaped `{"errors": ["message", ...]}`. */
async function firstErrorMessage(res: { json: () => Promise<unknown> }): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    if (typeof body !== 'object' || body === null) return undefined;
    const errors = (body as Record<string, unknown>)['errors'];
    const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
    return typeof first === 'string' ? first : undefined;
  } catch {
    // Not JSON, or no body: fall through to undefined.
    return undefined;
  }
}

/** OpenSea's response shape is not guaranteed, so the likely fields are probed for the calldata. */
export function extractCalldata(body: unknown): `0x${string}` | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;

  // Try common shapes: { transaction: { data } }, { data }, { calldata }, { tx: { data } }
  const candidates: unknown[] = [
    (b['transaction'] as Record<string, unknown> | undefined)?.['data'],
    (b['tx'] as Record<string, unknown> | undefined)?.['data'],
    b['data'],
    b['calldata'],
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && /^0x[0-9a-fA-F]+$/.test(c)) {
      return c as `0x${string}`;
    }
  }
  return null;
}

/** Decodes SeaDrop mintAllowList calldata to pull out mintParams + proof. */
export function decodeAllowListCalldata(calldata: `0x${string}`): OpenSeaAllowListData {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: SEADROP_ABI, data: calldata });
  } catch {
    throw new OpenSeaDropError('not_seadrop', "OpenSea's mint calldata did not decode as a known SeaDrop function.");
  }

  if (decoded.functionName !== 'mintAllowList') {
    throw new OpenSeaDropError(
      'not_seadrop',
      `Expected a mintAllowList transaction from OpenSea but got "${decoded.functionName}". This path is for allow-list stages only.`,
    );
  }

  // args: [nftContract, feeRecipient, minterIfNotPayer, quantity, mintParams, proof]
  const args = decoded.args as unknown as [
    string,
    string,
    string,
    bigint,
    {
      mintPrice: bigint;
      maxTotalMintableByWallet: bigint;
      startTime: bigint;
      endTime: bigint;
      dropStageIndex: bigint;
      maxTokenSupplyForStage: bigint;
      feeBps: bigint;
      restrictFeeRecipients: boolean;
    },
    readonly `0x${string}`[],
  ];

  const rawParams = args[4];
  const proof = args[5];

  const mintParams: MintParams = {
    mintPrice: rawParams.mintPrice,
    maxTotalMintableByWallet: Number(rawParams.maxTotalMintableByWallet),
    startTime: Number(rawParams.startTime),
    endTime: Number(rawParams.endTime),
    dropStageIndex: Number(rawParams.dropStageIndex),
    maxTokenSupplyForStage: rawParams.maxTokenSupplyForStage,
    feeBps: Number(rawParams.feeBps),
    restrictFeeRecipients: rawParams.restrictFeeRecipients,
  };

  return { mintParams, proof };
}
