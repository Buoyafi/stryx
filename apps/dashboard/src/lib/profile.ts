import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from './api';

/** What GET /auth/me returns: the signed-in account, never its password hash. */
export interface Me {
  id: string;
  /** Null for an account made by wallet sign-in. */
  email: string | null;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED';
  /** The name to greet them by on Home. Optional: an API from before it existed does not send it. */
  displayName?: string | null;
  discordHandle: string | null;
  xHandle: string | null;
  createdAt: string;
  /** How this session signed in (apps/api /auth/me). */
  signedInWith?: 'token' | 'wallet' | 'password';
  /** The wallets that can sign this account in. */
  signInAddresses?: string[];
}

export const meKey = ['me'] as const;

export function useMe(enabled = true) {
  return useQuery({ queryKey: meKey, queryFn: () => apiRequest<Me>('/auth/me'), staleTime: 60_000, enabled });
}

export function useSaveProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { displayName?: string; discordHandle?: string; xHandle?: string }) => apiRequest<Me>('/me/profile', { method: 'PATCH', body }),
    onSuccess: (me) => queryClient.setQueryData(meKey, me),
  });
}

/**
 * The same rules the API applies (services/user-service ProfileUpdateSchema), checked here first so a
 * typo is flagged while typing.
 */
export function handleProblem(kind: 'discord' | 'x', raw: string): string | null {
  const value = raw.trim().replace(/^@+/, '');
  if (value === '') return null;
  if (kind === 'discord') {
    return /^[a-z0-9_.]{2,32}$/.test(value.toLowerCase()) && !value.includes('..') ? null : 'Use 2 to 32 letters, numbers, "_" or ".".';
  }
  return /^[A-Za-z0-9_]{1,15}$/.test(value) ? null : 'Use up to 15 letters, numbers or "_".';
}

/** How the API will store it, so an unchanged field is not saved again. */
export function normaliseHandle(kind: 'discord' | 'x', raw: string): string {
  const value = raw.trim().replace(/^@+/, '');
  return kind === 'discord' ? value.toLowerCase() : value;
}

/** The longest display name the API keeps (services/user-service DISPLAY_NAME_MAX). */
export const DISPLAY_NAME_MAX = 32;

/** How the API stores a display name: spaces tidied. */
export function normaliseDisplayName(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** The API's display-name rules, checked while typing. Null when fine (an empty box clears the name). */
export function displayNameProblem(raw: string): string | null {
  const value = normaliseDisplayName(raw);
  if (value === '') return null;
  if (value.length > DISPLAY_NAME_MAX) return `Keep it to ${DISPLAY_NAME_MAX} characters or fewer.`;
  if (!/^[\p{L}\p{M}\p{N} .'_-]+$/u.test(value) || !/[\p{L}\p{N}]/u.test(value)) return "Use letters, numbers, spaces and . ' - _ only.";
  return null;
}
