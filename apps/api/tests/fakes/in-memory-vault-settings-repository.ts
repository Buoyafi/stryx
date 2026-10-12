import type { VaultSettingRecord, VaultSettingsRepository } from '../../src/vault-settings-repository.js';

export class InMemoryVaultSettingsRepository implements VaultSettingsRepository {
  private readonly rows = new Map<string, VaultSettingRecord>();

  async get(ownerId: string, chainId: number): Promise<VaultSettingRecord | null> {
    return this.rows.get(this.key(ownerId, chainId)) ?? null;
  }

  async set(setting: { ownerId: string; chainId: number; enabled: boolean; vaultAddress: string | null }): Promise<VaultSettingRecord> {
    const record: VaultSettingRecord = { ...setting, updatedAt: new Date() };
    this.rows.set(this.key(setting.ownerId, setting.chainId), record);
    return record;
  }

  private key(ownerId: string, chainId: number): string {
    return `${ownerId}:${chainId}`;
  }
}
