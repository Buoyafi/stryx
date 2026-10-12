import type Redis from 'ioredis';
import type { KeyManagementProvider, WalletKeyService } from '@stryx/key-management';
import type { WalletKeyRecordProvider } from '@stryx/transaction-engine';
import type { Logger } from '@stryx/logger';

/** One stage of a drop, as OpenSea's per-wallet eligibility endpoint describes it. */
export interface DropEligibilityStage {
  stage_uuid: string;
  is_eligible: boolean;
  price: string | null;
  max_total_mintable_by_wallet: string | null;
  max_total_mintable_by_wallet_per_token: string | null;
}

export type OpenSeaStagesAnswer = { ok: true; stages: DropEligibilityStage[] } | { ok: false; reason: 'opensea_auth_failed' | 'opensea_eligibility_failed' };

/** Asks OpenSea which stages of a drop a wallet may mint in. */
export interface OpenSeaEligibilitySource {
  stagesFor(wallet: { id: string; address: `0x${string}` }, slug: string): Promise<OpenSeaStagesAnswer>;
  /** Drops whatever is held for a wallet, for when the wallet itself is deleted. */
  forget(walletId: string): Promise<void>;
}

export interface OpenSeaEligibilityDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  openSeaApiKey: string | undefined;
  redis: Redis;
  kms: KeyManagementProvider;
  walletKeyService: WalletKeyService;
  walletKeyRecords: WalletKeyRecordProvider;
}

const MODULE_PATH = './private/opensea-eligibility/index.js';

/** Loads the optional module that answers signed-stage eligibility. */
export async function loadOpenSeaEligibilitySource(deps: OpenSeaEligibilityDeps, logger: Logger): Promise<OpenSeaEligibilitySource | null> {
  let mod: { createOpenSeaEligibilitySource(deps: OpenSeaEligibilityDeps): OpenSeaEligibilitySource };
  try {
    mod = await import(MODULE_PATH);
  } catch (err) {
    const missing = (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' && String((err as Error).message).includes('opensea-eligibility');
    if (!missing) throw err;
    logger.warn('signed-stage eligibility is on, but its optional module is not installed; it stays off');
    return null;
  }
  return mod.createOpenSeaEligibilitySource(deps);
}
