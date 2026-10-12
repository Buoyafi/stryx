import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDownload, apiRequest } from './api';

/** One person on the landing page waitlist (apps/api GET /admin/waitlist). */
export interface WaitlistEntry {
  id: string;
  email: string;
  status: 'waiting' | 'invited';
  note: string | null;
  invitedAt: string | null;
  createdAt: string;
}

export interface WaitlistData {
  counts: { waiting: number; invited: number };
  entries: WaitlistEntry[];
  /** Whether this server can email invites (RESEND_API_KEY set). Missing on an older API: false. */
  inviteEmail?: boolean;
}

export type WaitlistFilter = 'all' | 'waiting' | 'invited';

export const waitlistKey = ['admin', 'waitlist'] as const;

export function useWaitlist(filter: WaitlistFilter) {
  return useQuery({ queryKey: [...waitlistKey, filter], queryFn: () => apiRequest<WaitlistData>(`/admin/waitlist?status=${filter}`) });
}

export function useSetInvited() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; invited: boolean }) => apiRequest(`/admin/waitlist/${encodeURIComponent(v.id)}/invited`, { method: 'POST', body: { invited: v.invited } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: waitlistKey }),
  });
}

/** Makes the person a 14-day invite code, emails it, and marks them invited (all or nothing). */
export function useSendInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest<{ entry: WaitlistEntry; expiresAt: string }>(`/admin/waitlist/${encodeURIComponent(id)}/send-invite`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: waitlistKey }),
  });
}

export function useRemoveFromWaitlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest(`/admin/waitlist/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: waitlistKey }),
  });
}

/** Downloads the whole list as a CSV file (recorded on the audit log). */
export async function downloadWaitlistCsv(): Promise<void> {
  const blob = await apiDownload('/admin/waitlist/export');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stryx-waitlist.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
