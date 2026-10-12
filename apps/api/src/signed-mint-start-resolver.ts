import { isRpcTransportFailure, withTimeout } from '@stryx/utils';
import type { SeaDropReader, SignedMintValidationParams } from '@stryx/nft-engine';
import type { DropStagesSnapshot, OpenSeaSignedMintClient } from './opensea-signed-mint-client.js';

const OPENSEA_TIMEOUT_MS = 8_000;

export interface SignedStageTiming {
  stageUuid: string;
  label: string;
  startMs: number;
  endMs: number | null;
  /** OpenSea's advertised per-token price for the stage, wei string, or null if it gave none. */
  priceWei: string | null;
  maxPerWallet: number | null;
  /** The on-chain window any listed signer would accept (the widest of them), unix seconds. */
  onChainWindow: { minStartTime: number; maxEndTime: number; signerCount: number };
}

export type SignedStageResolution =
  | { ok: true; timing: SignedStageTiming; snapshot: DropStagesSnapshot }
  | {
      ok: false;
      reason: 'opensea_unavailable' | 'stage_not_found' | 'not_signed_stage' | 'no_start_time' | 'rpc_unavailable' | 'no_signers' | 'outside_onchain_bounds';
      detail: string;
    };

/** Where a signed stage's start time comes from: OpenSea's drop data, cross-checked against the signer's bounds on chain. */
export async function resolveSignedStage(
  openSea: OpenSeaSignedMintClient,
  reader: SeaDropReader,
  params: { slug: string; stageUuid: string; chainId: number; contract: `0x${string}` },
): Promise<SignedStageResolution> {
  let snapshot: DropStagesSnapshot;
  try {
    snapshot = await withTimeout(openSea.getDropStages(params.slug), OPENSEA_TIMEOUT_MS, 'OpenSea drop read');
  } catch (err) {
    return { ok: false, reason: 'opensea_unavailable', detail: err instanceof Error ? err.message : String(err) };
  }

  const stage = snapshot.stages.find((s) => s.uuid !== null && normalizeUuid(s.uuid) === normalizeUuid(params.stageUuid));
  if (!stage) return { ok: false, reason: 'stage_not_found', detail: `OpenSea's drop "${params.slug}" has no stage ${params.stageUuid}.` };
  if (stage.stageType !== 'signed_presale') {
    return { ok: false, reason: 'not_signed_stage', detail: `Stage "${stage.label}" is ${stage.stageType}, not a signed stage.` };
  }
  const startMs = stage.startTime ? Date.parse(stage.startTime) : NaN;
  if (Number.isNaN(startMs)) return { ok: false, reason: 'no_start_time', detail: `OpenSea gives no start time for "${stage.label}".` };
  const endParsed = stage.endTime ? Date.parse(stage.endTime) : NaN;
  const endMs = Number.isNaN(endParsed) ? null : endParsed;

  let bounds: Map<string, SignedMintValidationParams>;
  try {
    bounds = await readSignerBounds(reader, { nftContract: params.contract, chainId: params.chainId });
  } catch (err) {
    if (isRpcTransportFailure(err)) return { ok: false, reason: 'rpc_unavailable', detail: 'Could not read the contract\'s signers.' };
    throw err;
  }
  const configured = [...bounds.values()].filter((b) => b.maxMaxTotalMintableByWallet > 0);
  if (configured.length === 0) return { ok: false, reason: 'no_signers', detail: 'The contract has no signed-mint signer configured.' };

  const startSec = Math.floor(startMs / 1000);
  const endSec = endMs === null ? null : Math.floor(endMs / 1000);
  const accepting = configured.filter((b) => b.minStartTime <= startSec && (endSec === null || endSec <= b.maxEndTime));
  if (accepting.length === 0) {
    return {
      ok: false,
      reason: 'outside_onchain_bounds',
      detail: `OpenSea's window for "${stage.label}" falls outside every on-chain signer's allowed start/end.`,
    };
  }

  return {
    ok: true,
    snapshot,
    timing: {
      stageUuid: params.stageUuid,
      label: stage.label,
      startMs,
      endMs,
      priceWei: stage.priceWei,
      maxPerWallet: stage.maxPerWallet,
      onChainWindow: {
        minStartTime: Math.min(...configured.map((b) => b.minStartTime)),
        maxEndTime: Math.max(...configured.map((b) => b.maxEndTime)),
        signerCount: configured.length,
      },
    },
  };
}

/** Every listed signer's on-chain bounds, keyed by lowercase address. */
export async function readSignerBounds(
  reader: SeaDropReader,
  scope: { nftContract: `0x${string}`; chainId: number },
): Promise<Map<string, SignedMintValidationParams>> {
  const signers = await reader.getSigners(scope);
  const entries = await Promise.all(signers.map(async (signer) => [signer.toLowerCase(), await reader.getSignedMintValidationParams(scope, signer)] as const));
  return new Map(entries);
}

/** OpenSea formats the same stage id differently between endpoints (see mint-eligibility.service.ts). */
function normalizeUuid(id: string): string {
  return id.toLowerCase().replace(/[^0-9a-f]/g, '');
}
