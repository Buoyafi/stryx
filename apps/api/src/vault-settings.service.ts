import type { VaultSettingRecord, VaultSettingsRepository } from './vault-settings-repository.js';

/** One vault address per owner per chain. An unconfigured chain reads as disabled, never null. */
export class VaultSettingsService {
  constructor(private readonly repository: VaultSettingsRepository) {}

  async get(ownerId: string, chainId: number): Promise<{ enabled: boolean; vaultAddress: string | null }> {
    const row = await this.repository.get(ownerId, chainId);
    return row ? { enabled: row.enabled, vaultAddress: row.vaultAddress } : { enabled: false, vaultAddress: null };
  }

  async set(params: { ownerId: string; chainId: number; enabled: boolean; vaultAddress: string | null }): Promise<VaultSettingRecord> {
    if (params.enabled && !params.vaultAddress) {
      throw new VaultAddressRequiredError();
    }
    return this.repository.set(params);
  }
}

export class VaultAddressRequiredError extends Error {
  constructor() {
    super('A vault address is required to enable auto-drain.');
    this.name = 'VaultAddressRequiredError';
  }
}
