import { withTimeout } from '@stryx/utils';
import type { ChainServices } from './chain-services.js';
import type { OpenSeaDropInfo } from './opensea-drop-info.js';

/** Above the RPC transport's own worst case (2 attempts of 5s), so a retry about to succeed is never cut off. */
const READ_TIMEOUT_MS = 12_000;

export type PhaseKind = 'public' | 'allowlist';
export type PhaseSource = 'on-chain' | 'opensea';

/**
 * How an allow-list phase is gated. SeaDrop supports three ways (a Merkle proof, a server signature, a
 * token gate) and eligibility is checked differently for each.
 */
export type AllowListMechanism = 'merkle' | 'signed' | 'token-gated' | 'unknown';

export interface Phase {
  id: string;
  name: string;
  kind: PhaseKind;
  /** Wei, as a string (JSON has no bigint). Null when neither source has a price for it. */
  priceWei: string | null;
  /** Set when the price is in an ERC-20, not the native token: see OpenSeaStageInfo.priceToken. */
  priceToken?: string;
  startMs: number | null;
  endMs: number | null;
  maxPerWallet: number | null;
  /** Which source actually supplied price/timing/maxPerWallet: see the module doc comment. */
  source: PhaseSource;
  /** Null for the public phase (not an allow-list at all). See AllowListMechanism. */
  mechanism: AllowListMechanism | null;
  /**
   * OpenSea's own stage id, when the phase came from their drop data: needed to match a row of their
   * eligibility answer, whose order differs.
   */
  openSeaStageUuid: string | null;
}

function allowListMechanism(stageType: string): AllowListMechanism {
  if (stageType === 'signed_presale') return 'signed';
  if (/token/i.test(stageType)) return 'token-gated';
  if (/presale|allowlist|allow_list/i.test(stageType)) return 'merkle';
  return 'unknown';
}

const isoToMs = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Lists every phase of a drop. The chain can only answer for the public stage; allow-list phases are
 * listed when OpenSea's drop data names them.
 */
export async function listPhases(chainId: number, contract: `0x${string}`, services: ChainServices, dropInfo: OpenSeaDropInfo | null): Promise<Phase[]> {
  const scope = { nftContract: contract, chainId };
  const publicDrop = await withTimeout(services.seaDropReader.getPublicDrop(scope), READ_TIMEOUT_MS, `getPublicDrop read (chain ${chainId})`);
  const publicConfigured = publicDrop.startTime !== 0;

  const stages = dropInfo?.stages ?? [];
  const publicSaleIndex = stages.findIndex((s) => s.stageType === 'public_sale');
  const publicSaleStage = publicSaleIndex >= 0 ? stages[publicSaleIndex] : undefined;

  const phases: Phase[] = [];

  if (publicConfigured) {
    phases.push({
      id: 'public',
      // OpenSea's label when it has one, otherwise "Public".
      name: publicSaleStage?.label ?? 'Public',
      kind: 'public',
      priceWei: publicDrop.mintPrice.toString(),
      startMs: publicDrop.startTime * 1000,
      endMs: publicDrop.endTime * 1000,
      maxPerWallet: publicDrop.maxTotalMintableByWallet,
      source: 'on-chain',
      mechanism: null,
      openSeaStageUuid: publicSaleStage?.uuid ?? null,
    });
  }

  stages.forEach((stage, i) => {
    // Skip OpenSea's public_sale entry only when it was folded into the on-chain phase above.
    if (i === publicSaleIndex && publicConfigured) return;
    phases.push({
      id: `opensea-${i}`,
      name: stage.label,
      kind: stage.stageType === 'public_sale' ? 'public' : 'allowlist',
      priceWei: stage.priceWei,
      ...(stage.priceToken ? { priceToken: stage.priceToken } : {}),
      startMs: isoToMs(stage.startTime),
      endMs: isoToMs(stage.endTime),
      maxPerWallet: stage.maxPerWallet,
      source: 'opensea',
      mechanism: stage.stageType === 'public_sale' ? null : allowListMechanism(stage.stageType),
      openSeaStageUuid: stage.uuid,
    });
  });

  return phases;
}
