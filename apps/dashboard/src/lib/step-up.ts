import { apiRequest } from './api';

export function stepUp(credential: string): Promise<{ ok: true }> {
  return apiRequest('/auth/step-up', { method: 'POST', body: { credential } });
}
