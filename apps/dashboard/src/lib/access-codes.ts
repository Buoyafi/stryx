import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from './api';

/** One invite code as the admin list shows it (apps/api GET /admin/access-codes). The code itself is never listed. */
export interface AccessCodeRow {
  id: string;
  label: string | null;
  status: 'unused' | 'used' | 'revoked' | 'expired';
  boundAddress: string | null;
  expiresAt: string | null;
  createdAt: string;
  redeemedAt: string | null;
  redeemedByAddress: string | null;
  revokedAt: string | null;
}

export const accessCodesKey = ['admin', 'access-codes'] as const;

export function useAccessCodes() {
  return useQuery({ queryKey: accessCodesKey, queryFn: () => apiRequest<{ codes: AccessCodeRow[] }>('/admin/access-codes') });
}

export function useCreateAccessCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { label?: string; expiresInDays?: number; boundAddress?: string }) => apiRequest<{ code: string; id: string; expiresAt: string | null }>('/admin/access-codes', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: accessCodesKey }),
  });
}

export function useRevokeAccessCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest(`/admin/access-codes/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: accessCodesKey }),
  });
}
