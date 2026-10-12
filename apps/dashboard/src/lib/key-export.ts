import { apiRequest } from './api';

export function exportWalletKey(walletId: string): Promise<{ address: string; privateKey: string }> {
  return apiRequest(`/wallets/${walletId}/export-key`, { method: 'POST' });
}
