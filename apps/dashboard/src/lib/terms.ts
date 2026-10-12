import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from './api';

/** What GET /me/terms returns (apps/api terms-controller.ts). */
export interface TermsStatus {
  /** False when the server is not asking anyone to accept anything. */
  required: boolean;
  accepted: boolean;
  termsVersion: string | null;
  privacyVersion: string | null;
  acceptedAt: string | null;
}

/** Where the published Terms of Use and Privacy Policy are (VITE_TERMS_URL, VITE_PRIVACY_URL). Unset: shown as plain text. */
export const TERMS_URL: string | undefined = import.meta.env.VITE_TERMS_URL || undefined;
export const PRIVACY_URL: string | undefined = import.meta.env.VITE_PRIVACY_URL || undefined;

export const termsKey = ['me', 'terms'] as const;

export function useTermsStatus(enabled = true) {
  return useQuery({ queryKey: termsKey, queryFn: () => apiRequest<TermsStatus>('/me/terms'), staleTime: 60_000, enabled });
}

export function useAcceptTerms() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versions: { termsVersion: string; privacyVersion: string }) => apiRequest<TermsStatus>('/me/terms/accept', { method: 'POST', body: versions }),
    onSuccess: (status) => queryClient.setQueryData(termsKey, status),
    // The page was open across a change of version: re-read what is in force.
    onError: () => void queryClient.invalidateQueries({ queryKey: termsKey }),
  });
}
