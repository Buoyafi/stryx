import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chainById } from '@stryx/chains';
import { apiRequest } from './api';
import { formatUnits } from './wei-format';
import { blockedReason } from './server-mints';
import type { ChartBucket } from './outcome-chart';

/**
 * The operator Overview's data (apps/api admin-overview-controller.ts): platform numbers for a window,
 * and three lists (every member's mints, members, the audit log).
 */

export type StatsWindow = '24h' | '7d' | '30d';
export type FailureClass = 'USER' | 'POLICY' | 'INFRA' | 'CHAIN' | 'OTHER';

export interface Overview {
  asOf: string;
  window: StatsWindow;
  since: string;
  dataStartsAt: string | null;
  members: { total: number; new: number; active: number; activated: number; suspended: number; admins: number };
  mints: {
    settled: number;
    confirmed: number;
    reverted: number;
    blocked: number;
    dropped: number;
    pending: number;
    successRate: number | null;
    healthRate: number | null;
    failures: Record<FailureClass, number>;
    topReasons: { reason: string; failureClass: FailureClass; count: number }[];
  };
  chains: { chainId: number; settled: number; confirmed: number; failed: number; pending: number; successRate: number | null; feeWei: string; burnedWei: string }[];
  sources: { source: string; count: number }[];
  collections: { chainId: number; contract: string; mints: number; confirmed: number; members: number }[];
  /** Mints per hour (24 hours) or UTC day (7 and 30 days), for the chart. */
  series?: { unit: 'hour' | 'day'; buckets: ChartBucket[] };
}

export interface PlatformMint {
  id: string;
  ownerId: string;
  ownerName: string | null;
  walletAddress: string;
  chainId: number;
  contract: string;
  kind: string;
  quantity: number;
  source: string;
  status: string;
  failureReason: string | null;
  failureNote: string | null;
  txHash: string | null;
  createdAt: string;
}

export interface MemberRow {
  id: string;
  displayName: string | null;
  role: string;
  status: string;
  createdAt: string;
  signInAddresses: string[];
  wallets: number;
  mints: number;
  lastMintAt: string | null;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  actorType: string;
  actorUserId: string | null;
  actorName: string | null;
  targetUserId: string | null;
  walletId: string | null;
  outcome: string;
  detail: string | null;
}

export interface MemberDetail {
  member: { id: string; displayName: string | null; role: string; status: string; email: string | null; discordHandle: string | null; xHandle: string | null; createdAt: string };
  signInWallets: { address: string; addedAt: string; lastUsedAt: string | null }[];
  wallets: { id: string; address: string; label: string | null; tier: string; status: string; origin: string; createdAt: string }[];
  mints: Overview['mints'];
  recentMints: PlatformMint[];
  audit: AuditEntry[];
}

export const memberKey = (id: string) => ['admin', 'member', id] as const;

/** One member's page. Needs a fresh confirmation (step-up): the error says `step_up_required` until then. */
export function useMemberDetail(id: string) {
  return useQuery({ queryKey: memberKey(id), queryFn: () => apiRequest<MemberDetail>(`/admin/members/${encodeURIComponent(id)}`), retry: false, staleTime: 30_000 });
}

export function useSetMemberStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { suspend: boolean; reason?: string }) =>
      apiRequest<{ status: string; sessionsEnded?: number }>(`/admin/members/${encodeURIComponent(id)}/${input.suspend ? 'suspend' : 'unsuspend'}`, {
        method: 'POST',
        ...(input.suspend ? { body: input.reason ? { reason: input.reason } : {} } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: memberKey(id) });
      void qc.invalidateQueries({ queryKey: ['admin', 'members'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
    },
  });
}

export type AuditCategory = 'signins' | 'mints' | 'wallets' | 'admin' | 'stops' | 'profile';

export const AUDIT_CATEGORIES: readonly { value: AuditCategory | ''; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'signins', label: 'Sign-ins and sign-ups' },
  { value: 'mints', label: 'Mints' },
  { value: 'wallets', label: 'Wallets, Disperse, NFTs' },
  { value: 'admin', label: 'Admin, codes, roles, caps' },
  { value: 'stops', label: 'Emergency stops' },
  { value: 'profile', label: 'Profile changes' },
];

export const WINDOWS: readonly { value: StatsWindow; label: string }[] = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export function useOverview(window: StatsWindow) {
  return useQuery({
    queryKey: ['admin', 'overview', window],
    queryFn: () => apiRequest<Overview>(`/admin/overview?window=${window}`),
    refetchInterval: 60_000,
    retry: false,
  });
}

function usePaged<T>(key: readonly unknown[], path: string, pick: (page: Record<string, unknown>) => T[], refetchMs?: number) {
  return useInfiniteQuery({
    queryKey: key,
    queryFn: async ({ pageParam }) => {
      const sep = path.includes('?') ? '&' : '?';
      const page = await apiRequest<Record<string, unknown> & { nextBefore: string | null }>(`${path}${pageParam ? `${sep}before=${encodeURIComponent(pageParam)}` : ''}`);
      return { rows: pick(page), nextBefore: page.nextBefore };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    retry: false,
    ...(refetchMs ? { refetchInterval: refetchMs } : {}),
  });
}

/** Every member's mints, newest first. Refreshes every 10 seconds: it is the live feed. */
export const usePlatformActivity = () => usePaged<PlatformMint>(['admin', 'activity'], '/admin/activity?limit=50', (p) => p['mints'] as PlatformMint[], 10_000);
export const useMembers = () => usePaged<MemberRow>(['admin', 'members'], '/admin/members?limit=100', (p) => p['members'] as MemberRow[]);
export const useAuditLog = (category: AuditCategory | '') =>
  usePaged<AuditEntry>(['admin', 'audit', category], `/admin/audit?limit=100${category ? `&category=${category}` : ''}`, (p) => p['entries'] as AuditEntry[], 30_000);

// ---------------------------------------------------------------- formatting

/** 1,284 / 12.9K / 3.1M. */
export function count(n: number): string {
  return n < 10_000 ? n.toLocaleString() : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** 93% / 99.4%; a rate that does not exist says so, never "0%". */
export function rate(r: number | null): string {
  if (r === null) return '-';
  // Rounded to one decimal first: 0.9 * 100 is 90.00000000000001 in floating point.
  const pct = Math.round(r * 1000) / 10;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** A chain's gas total in its own token: "0.0042 ETH". */
export function gas(chainId: number, wei: string): string {
  const chain = chainById(chainId);
  const symbol = chain?.nativeCurrency.symbol ?? '';
  const value = formatUnits(wei, chain?.nativeCurrency.decimals ?? 18);
  const [whole = '0', frac = ''] = value.split('.');
  // Gas is small: keep 4 decimals above 1, otherwise enough to show 2 significant digits (at least 6).
  const keep = whole !== '0' ? 4 : Math.max(6, frac.search(/[1-9]/) + 2);
  const decimals = frac.slice(0, keep).replace(/0+$/, '');
  return `${decimals ? `${whole}.${decimals}` : whole} ${symbol}`.trim();
}

export const CLASS_LABEL: Record<FailureClass, string> = {
  USER: 'Member side',
  POLICY: 'Safety and policy',
  INFRA: 'Infrastructure',
  CHAIN: 'On chain',
  OTHER: 'Other',
};

export const CLASS_HINT: Record<FailureClass, string> = {
  USER: 'Not eligible, stage not open, not enough funds',
  POLICY: 'Emergency stop, spend caps, refused calldata',
  INFRA: 'RPC or OpenSea down, interrupted',
  CHAIN: 'Reverted in simulation or on chain, dropped',
  OTHER: 'A reason not classified yet',
};

/** A failure reason as words. */
export function reasonLabel(reason: string): string {
  if (reason === 'reverted_onchain') return 'Reverted on chain';
  if (reason === 'dropped') return 'Dropped, never mined';
  return blockedReason(reason, null);
}

export const SOURCE_LABEL: Record<string, string> = { MANUAL: 'Fired from the dashboard', SCHEDULED: 'Scheduled', API: 'Through the API' };

/** An audit action as words: "session.login_wallet" to "Signed in with a wallet". */
const ACTION_LABEL: Record<string, string> = {
  'session.login_wallet': 'Signed in with a wallet',
  'session.login': 'Signed in with a password',
  'session.logout': 'Signed out',
  'session.signup': 'Signed up',
  'account.create_wallet': 'Joined with an invite code',
  'access_code.create': 'Made an invite code',
  'access_code.revoke': 'Revoked an invite code',
  'access_code.check': 'Checked an invite code',
  'admin.denied': 'Refused an admin page',
  'admin.view_activity': 'Viewed all members’ mints',
  'admin.view_members': 'Viewed the member list',
  'admin.view_audit': 'Viewed the audit log',
  'admin.view_waitlist': 'Viewed the waitlist',
  'waitlist.export': 'Exported the waitlist',
  'waitlist.invite': 'Marked a waitlist person invited',
  'waitlist.uninvite': 'Un-marked a waitlist person as invited',
  'waitlist.delete': 'Removed someone from the waitlist',
  'role.grant': 'Made an account admin',
  'role.revoke': 'Made an admin a member',
  'spend_cap.disable': 'Turned off spend caps',
  'spend_cap.enable': 'Turned spend caps back on',
  'operator.adopt_wallet': 'Added an operator sign-in wallet',
  'mint.public': 'Public mint',
  'mint.allowlist': 'Allowlist mint',
  'mint.signed': 'Signed mint',
  'mint.signed.schedule': 'Scheduled a signed mint',
  'wallet.export_key': 'Exported a private key',
  'disperse': 'Disperse',
  'nft.transfer': 'Sent an NFT',
  'vault.settings.update': 'Changed vault settings',
  'profile.update': 'Updated profile',
  'session.logout_all': 'Signed out everywhere',
  'admin.view_user': 'Opened a member’s page',
  'admin.suspend_user': 'Suspended a member',
  'admin.unsuspend_user': 'Reactivated a member',
};

export function actionLabel(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  if (action.startsWith('emergency_stop.')) {
    const rest = action.slice('emergency_stop.'.length).replace(/[._]/g, ' ');
    return `Emergency stop: ${rest}`;
  }
  const text = action.replace(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);
export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
