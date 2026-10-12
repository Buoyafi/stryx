export interface VaultSettingRecord {
  ownerId: string;
  chainId: number;
  enabled: boolean;
  vaultAddress: string | null;
  updatedAt: Date;
}

/** Structural, not `import type { PrismaClient }`, same pattern as every other repository here. */
export interface VaultSettingPrismaDelegate {
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown | null>;
  upsert(args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<unknown>;
}

export interface VaultSettingsRepository {
  get(ownerId: string, chainId: number): Promise<VaultSettingRecord | null>;
  set(setting: { ownerId: string; chainId: number; enabled: boolean; vaultAddress: string | null }): Promise<VaultSettingRecord>;
}

export class PrismaVaultSettingsRepository implements VaultSettingsRepository {
  constructor(private readonly vaultSetting: VaultSettingPrismaDelegate) {}

  async get(ownerId: string, chainId: number): Promise<VaultSettingRecord | null> {
    const row = await this.vaultSetting.findUnique({ where: { ownerId_chainId: { ownerId, chainId } } });
    return row as VaultSettingRecord | null;
  }

  async set(setting: { ownerId: string; chainId: number; enabled: boolean; vaultAddress: string | null }): Promise<VaultSettingRecord> {
    const key = { ownerId: setting.ownerId, chainId: setting.chainId };
    const row = await this.vaultSetting.upsert({
      where: { ownerId_chainId: key },
      create: { ...key, enabled: setting.enabled, vaultAddress: setting.vaultAddress },
      update: { enabled: setting.enabled, vaultAddress: setting.vaultAddress },
    });
    return row as VaultSettingRecord;
  }
}
