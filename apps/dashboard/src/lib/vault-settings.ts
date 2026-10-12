import { apiRequest } from './api';

export interface VaultSettings {
  enabled: boolean;
  vaultAddress: string | null;
  lastDrainFailure: { contract: string; tokenId: string; error: string | null; at: string | null } | null;
}

export function fetchVaultSettings(chainId: number): Promise<VaultSettings> {
  return apiRequest<VaultSettings>(`/vault-settings?chainId=${chainId}`);
}

export function saveVaultSettings(params: {
  chainId: number;
  enabled: boolean;
  vaultAddress: string | null;
}): Promise<{ enabled: boolean; vaultAddress: string | null }> {
  return apiRequest('/vault-settings', { method: 'PUT', body: params });
}
