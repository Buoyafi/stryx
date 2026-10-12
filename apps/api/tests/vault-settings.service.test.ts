import { describe, expect, it } from 'vitest';
import { VaultAddressRequiredError, VaultSettingsService } from '../src/vault-settings.service.js';
import { InMemoryVaultSettingsRepository } from './fakes/in-memory-vault-settings-repository.js';

const OWNER = 'owner-1';
const CHAIN_ID = 46630;
const VAULT = '0x9999999999999999999999999999999999999999';

describe('VaultSettingsService', () => {
  it('returns a disabled shape for a chain nobody has configured yet, not null', async () => {
    const service = new VaultSettingsService(new InMemoryVaultSettingsRepository());
    expect(await service.get(OWNER, CHAIN_ID)).toEqual({ enabled: false, vaultAddress: null });
  });

  it('round-trips a saved setting', async () => {
    const service = new VaultSettingsService(new InMemoryVaultSettingsRepository());
    await service.set({ ownerId: OWNER, chainId: CHAIN_ID, enabled: true, vaultAddress: VAULT });

    expect(await service.get(OWNER, CHAIN_ID)).toEqual({ enabled: true, vaultAddress: VAULT });
  });

  it('refuses to enable auto-drain with no vault address', async () => {
    const service = new VaultSettingsService(new InMemoryVaultSettingsRepository());
    await expect(service.set({ ownerId: OWNER, chainId: CHAIN_ID, enabled: true, vaultAddress: null })).rejects.toThrow(
      VaultAddressRequiredError,
    );
  });

  it('allows disabling without a vault address (turning it back off)', async () => {
    const service = new VaultSettingsService(new InMemoryVaultSettingsRepository());
    await service.set({ ownerId: OWNER, chainId: CHAIN_ID, enabled: true, vaultAddress: VAULT });
    await service.set({ ownerId: OWNER, chainId: CHAIN_ID, enabled: false, vaultAddress: null });

    expect(await service.get(OWNER, CHAIN_ID)).toEqual({ enabled: false, vaultAddress: null });
  });

  it('scopes settings per chain and per owner', async () => {
    const service = new VaultSettingsService(new InMemoryVaultSettingsRepository());
    await service.set({ ownerId: OWNER, chainId: CHAIN_ID, enabled: true, vaultAddress: VAULT });

    expect(await service.get(OWNER, 999)).toEqual({ enabled: false, vaultAddress: null });
    expect(await service.get('someone-else', CHAIN_ID)).toEqual({ enabled: false, vaultAddress: null });
  });
});
