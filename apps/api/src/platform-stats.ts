import type { ListCursor } from './cursor.js';

/**
 * The operator's platform-wide numbers (ADR-003 §4.11): members, mints, success rate, why mints
 * failed, by chain and by collection, plus the live mint list, the member list and the audit log.
 */

export type StatsWindow = '24h' | '7d' | '30d';
export const WINDOW_MS: Record<StatsWindow, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

export type FailureClass = 'USER' | 'POLICY' | 'INFRA' | 'CHAIN' | 'OTHER';

const CLASS_OF: Record<string, FailureClass> = {
  // The member's own situation: not eligible, the stage not open, not enough funds, their choice.
  not_eligible: 'USER', no_active_public_stage: 'USER', insufficient_funds: 'USER', allowlist_not_found: 'USER',
  no_fee_recipient_configured: 'USER', other_stage_active: 'USER', gave_up: 'USER', price_above_expected: 'USER',
  wallet_not_active: 'USER', wallet_not_found: 'USER', no_start_time: 'USER', stage_not_found: 'USER',
  not_signed_stage: 'USER', aborted: 'USER', already_sent: 'USER',
  // A rule doing its job: emergency stop, spend caps, and the signed-mint safety checks refusing calldata.
  emergency_stop: 'POLICY', spending_cap_exceeded: 'POLICY', job_spend_limit: 'POLICY', execution_disabled: 'POLICY',
  calldata_invalid: 'POLICY', fee_recipient_not_allowed: 'POLICY', outside_onchain_bounds: 'POLICY', outside_signer_bounds: 'POLICY',
  unexpected_target: 'POLICY', price_above_limit: 'POLICY', unknown_signer: 'POLICY', wrong_contract: 'POLICY', wrong_minter: 'POLICY', wrong_quantity: 'POLICY',
  // Something Stryx depends on was down or broke.
  rpc_unavailable: 'INFRA', opensea_fetch_failed: 'INFRA', opensea_unavailable: 'INFRA', unsupported_chain: 'INFRA',
  interrupted: 'INFRA', internal_error: 'INFRA', send_unconfirmed: 'INFRA', history_unavailable: 'INFRA', warmup_failed: 'INFRA', send_failed: 'INFRA', no_signers: 'INFRA',
  // The chain said no.
  simulation_reverted: 'CHAIN', reverted_onchain: 'CHAIN',
};

/** Why a failed mint failed, as one of five classes. On-chain reverts and dropped mints are CHAIN. */
export function failureClass(status: string, reason: string | null): FailureClass | null {
  if (status === 'REVERTED' || status === 'DROPPED') return 'CHAIN';
  if (status !== 'BLOCKED') return null;
  return (reason && CLASS_OF[reason]) || 'OTHER';
}

export interface StatusCount {
  status: string;
  failureReason: string | null;
  count: number;
}

export interface MintTotals {
  settled: number;
  confirmed: number;
  reverted: number;
  blocked: number;
  dropped: number;
  pending: number;
  /** Null when nothing settled. */
  successRate: number | null;
  /** Success with USER and POLICY failures left out. Null when nothing is left to count. */
  healthRate: number | null;
  failures: Record<FailureClass, number>;
  /** The most common reasons, most first. */
  topReasons: { reason: string; failureClass: FailureClass; count: number }[];
}

export function mintTotals(rows: readonly StatusCount[]): MintTotals {
  const by = (s: string) => rows.filter((r) => r.status === s).reduce((n, r) => n + r.count, 0);
  const confirmed = by('CONFIRMED');
  const reverted = by('REVERTED');
  const blocked = by('BLOCKED');
  const dropped = by('DROPPED');
  const settled = confirmed + reverted + blocked + dropped;
  const failures: Record<FailureClass, number> = { USER: 0, POLICY: 0, INFRA: 0, CHAIN: 0, OTHER: 0 };
  const reasons = new Map<string, { reason: string; failureClass: FailureClass; count: number }>();
  for (const r of rows) {
    const cls = failureClass(r.status, r.failureReason);
    if (!cls) continue;
    failures[cls] += r.count;
    const reason = r.status === 'BLOCKED' ? r.failureReason ?? 'unknown' : r.status === 'REVERTED' ? 'reverted_onchain' : 'dropped';
    const entry = reasons.get(reason) ?? { reason, failureClass: cls, count: 0 };
    entry.count += r.count;
    reasons.set(reason, entry);
  }
  const healthBase = settled - failures.USER - failures.POLICY;
  return {
    settled,
    confirmed,
    reverted,
    blocked,
    dropped,
    pending: by('PENDING') + by('SENDING'),
    successRate: settled > 0 ? confirmed / settled : null,
    healthRate: healthBase > 0 ? confirmed / healthBase : null,
    failures,
    topReasons: [...reasons.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 8),
  };
}

export interface SeriesRow {
  bucket: Date;
  status: string;
  count: number;
}

export interface SeriesBucket {
  /** ISO times; a bucket is [start, end). Hours for 24 hours, UTC days for 7 and 30 days. */
  start: string;
  end: string;
  confirmed: number;
  /** Mined and reverted, or never mined (dropped): failed on chain. */
  reverted: number;
  /** Refused before anything was sent. */
  blocked: number;
  failed: number;
  pending: number;
  /** False when the bucket ends before the first mint on record: unknown, never zero. */
  recorded: boolean;
  /** The first mint on record falls inside this bucket, so it may be low. */
  partial: boolean;
}

export interface TimeSeries {
  unit: 'hour' | 'day';
  buckets: SeriesBucket[];
}

/** The buckets a window is drawn with, oldest first: 24 hours, or 7 / 30 UTC days, ending with the current one. */
export function seriesBuckets(window: StatsWindow, asOf: number): { unit: 'hour' | 'day'; starts: number[]; stepMs: number } {
  if (window === '24h') {
    const current = Math.floor(asOf / 3_600_000) * 3_600_000;
    return { unit: 'hour', stepMs: 3_600_000, starts: Array.from({ length: 24 }, (_, i) => current - (23 - i) * 3_600_000) };
  }
  const days = window === '7d' ? 7 : 30;
  const today = Math.floor(asOf / 86_400_000) * 86_400_000;
  return { unit: 'day', stepMs: 86_400_000, starts: Array.from({ length: days }, (_, i) => today - (days - 1 - i) * 86_400_000) };
}

/** Counts per bucket from per-bucket, per-status rows. */
export function timeSeries(window: StatsWindow, asOf: number, rows: readonly SeriesRow[], dataStartsAt: Date | null): TimeSeries {
  const { unit, starts, stepMs } = seriesBuckets(window, asOf);
  const first = dataStartsAt?.getTime() ?? null;
  const byStart = new Map<number, SeriesBucket>();
  const buckets = starts.map((start) => {
    const end = start + stepMs;
    const b: SeriesBucket = {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      confirmed: 0,
      reverted: 0,
      blocked: 0,
      failed: 0,
      pending: 0,
      recorded: first !== null && end > first,
      partial: first !== null && first > start && first < end,
    };
    byStart.set(start, b);
    return b;
  });
  for (const r of rows) {
    const b = byStart.get(r.bucket.getTime());
    if (!b) continue;
    if (r.status === 'CONFIRMED') b.confirmed += r.count;
    else if (r.status === 'REVERTED' || r.status === 'DROPPED') b.reverted += r.count;
    else if (r.status === 'BLOCKED') b.blocked += r.count;
    else b.pending += r.count;
  }
  for (const b of buckets) b.failed = b.reverted + b.blocked;
  return { unit, buckets };
}

export interface ChainRow {
  chainId: number;
  status: string;
  count: number;
  /** Sum of fees on this chain, in its own token (wei, as text). */
  feeWei: string;
}

export interface ChainSummary {
  chainId: number;
  settled: number;
  confirmed: number;
  failed: number;
  pending: number;
  successRate: number | null;
  /** Total gas paid on this chain, in its own token (wei, as text). Never added across chains. */
  feeWei: string;
  /** Gas paid by mints that reverted on chain (wei, as text). */
  burnedWei: string;
}

export function chainSummaries(rows: readonly ChainRow[]): ChainSummary[] {
  const chains = new Map<number, ChainSummary & { fee: bigint; burned: bigint }>();
  for (const r of rows) {
    const c = chains.get(r.chainId) ?? { chainId: r.chainId, settled: 0, confirmed: 0, failed: 0, pending: 0, successRate: null, feeWei: '0', burnedWei: '0', fee: 0n, burned: 0n };
    const fee = BigInt(r.feeWei || '0');
    c.fee += fee;
    if (r.status === 'CONFIRMED') c.confirmed += r.count;
    else if (r.status === 'PENDING' || r.status === 'SENDING') c.pending += r.count;
    else c.failed += r.count;
    if (r.status === 'REVERTED') c.burned += fee;
    chains.set(r.chainId, c);
  }
  return [...chains.values()]
    .map(({ fee, burned, ...c }) => {
      const settled = c.confirmed + c.failed;
      return { ...c, settled, successRate: settled > 0 ? c.confirmed / settled : null, feeWei: fee.toString(), burnedWei: burned.toString() };
    })
    .sort((a, b) => b.settled + b.pending - (a.settled + a.pending) || a.chainId - b.chainId);
}

export interface MemberCounts {
  /** Accounts with role USER. */
  total: number;
  /** Joined in the window. */
  new: number;
  /** Signed in or minted in the window. */
  active: number;
  /** Has a bot wallet or has minted, ever. */
  activated: number;
  suspended: number;
  admins: number;
}

export interface CollectionRow {
  chainId: number;
  contract: string;
  mints: number;
  confirmed: number;
  members: number;
}

export interface PlatformMintRow {
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
  createdAt: Date;
}

export interface MemberRow {
  id: string;
  displayName: string | null;
  role: string;
  status: string;
  createdAt: Date;
  signInAddresses: string[];
  wallets: number;
  mints: number;
  lastMintAt: Date | null;
}

export interface AuditRow {
  id: string;
  createdAt: Date;
  action: string;
  actorType: string;
  actorUserId: string | null;
  actorName: string | null;
  targetUserId: string | null;
  walletId: string | null;
  outcome: string;
  detail: string | null;
}

/** What the audit log can be filtered to, each a set of action prefixes. */
export const AUDIT_CATEGORIES: Record<string, readonly string[]> = {
  signins: ['session.', 'account.'],
  mints: ['mint.'],
  wallets: ['wallet.', 'disperse', 'nft.', 'vault.'],
  admin: ['admin.', 'access_code.', 'role.', 'operator.', 'spend_cap.', 'waitlist.'],
  stops: ['emergency_stop.'],
  profile: ['profile.'],
};

export interface MemberDetail {
  signInWallets: { address: string; addedAt: Date; lastUsedAt: Date | null }[];
  /** Bot wallets: never any key column. */
  wallets: { id: string; address: string; label: string | null; tier: string; status: string; origin: string; createdAt: Date }[];
  mintCounts: StatusCount[];
  recentMints: PlatformMintRow[];
  /** What they did, and what was done to them. */
  audit: AuditRow[];
}

export interface PlatformStatsRepository {
  mintStatusCounts(since: Date): Promise<StatusCount[]>;
  mintsByChain(since: Date): Promise<ChainRow[]>;
  mintsBySource(since: Date): Promise<{ source: string; count: number }[]>;
  /** Counts by UTC hour or day, and status, from `since`. */
  mintTimeseries(since: Date, unit: 'hour' | 'day'): Promise<SeriesRow[]>;
  topCollections(since: Date, limit: number): Promise<CollectionRow[]>;
  memberCounts(since: Date): Promise<MemberCounts>;
  /** When the earliest mint on record was made, or null. Before it, numbers are unknown, not zero. */
  dataStartsAt(): Promise<Date | null>;
  recentMints(opts: { before?: ListCursor; limit: number; ownerId?: string }): Promise<PlatformMintRow[]>;
  members(opts: { before?: ListCursor; limit: number }): Promise<MemberRow[]>;
  audit(opts: { before?: ListCursor; limit: number; prefixes?: readonly string[]; userId?: string }): Promise<AuditRow[]>;
  /** One member's sign-in wallets, bot wallets, mint counts, latest mints and audit entries. */
  memberDetail(userId: string, limit: number): Promise<MemberDetail>;
}

// ---------------------------------------------------------------- Postgres

interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** "createdAt" strictly before the cursor, newest first. `$n` numbering starts at `first`. */
function beforeClause(alias: string, before: ListCursor | undefined, first: number): { sql: string; values: unknown[] } {
  if (!before) return { sql: 'TRUE', values: [] };
  return { sql: `(${alias}."createdAt" < $${first} OR (${alias}."createdAt" = $${first} AND ${alias}."id" < $${first + 1}))`, values: [before.at, before.id] };
}

/** The SQL behind the numbers. */
export class PrismaPlatformStatsRepository implements PlatformStatsRepository {
  constructor(private readonly db: RawClient) {}

  mintStatusCounts(since: Date): Promise<StatusCount[]> {
    return this.db.$queryRawUnsafe<StatusCount[]>(
      `SELECT "status"::text AS status, "failureReason", count(*)::int AS count FROM "mint_events" WHERE "createdAt" >= $1 GROUP BY 1, 2`,
      since,
    );
  }

  mintsByChain(since: Date): Promise<ChainRow[]> {
    return this.db.$queryRawUnsafe<ChainRow[]>(
      `SELECT "chainId", "status"::text AS status, count(*)::int AS count, COALESCE(sum("feeWei"), 0)::text AS "feeWei"
         FROM "mint_events" WHERE "createdAt" >= $1 GROUP BY 1, 2`,
      since,
    );
  }

  mintsBySource(since: Date): Promise<{ source: string; count: number }[]> {
    return this.db.$queryRawUnsafe(`SELECT "source"::text AS source, count(*)::int AS count FROM "mint_events" WHERE "createdAt" >= $1 GROUP BY 1 ORDER BY 2 DESC`, since);
  }

  mintTimeseries(since: Date, unit: 'hour' | 'day'): Promise<SeriesRow[]> {
    // "createdAt" is a UTC timestamp without a zone, so date_trunc cuts at UTC hours and days.
    return this.db.$queryRawUnsafe<SeriesRow[]>(
      `SELECT date_trunc($2::text, "createdAt") AS bucket, "status"::text AS status, count(*)::int AS count
         FROM "mint_events" WHERE "createdAt" >= $1 GROUP BY 1, 2`,
      since,
      unit,
    );
  }

  topCollections(since: Date, limit: number): Promise<CollectionRow[]> {
    return this.db.$queryRawUnsafe<CollectionRow[]>(
      `SELECT "chainId", lower("contractAddress") AS contract, count(*)::int AS mints,
              (count(*) FILTER (WHERE "status" = 'CONFIRMED'))::int AS confirmed, count(DISTINCT "ownerId")::int AS members
         FROM "mint_events" WHERE "createdAt" >= $1 AND "status" NOT IN ('SENDING', 'PENDING')
        GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LIMIT $2`,
      since,
      limit,
    );
  }

  async memberCounts(since: Date): Promise<MemberCounts> {
    const [row] = await this.db.$queryRawUnsafe<MemberCounts[]>(
      `WITH members AS (SELECT "id", "status", "createdAt" FROM "users" WHERE "role" = 'USER'),
            active AS (
              SELECT "ownerId" AS id FROM "mint_events" WHERE "createdAt" >= $1
              UNION
              SELECT "actorUserId" FROM "audit_log"
               WHERE "createdAt" >= $1 AND "outcome" = 'SUCCESS' AND "actorUserId" IS NOT NULL
                 AND "action" IN ('session.login_wallet', 'session.login', 'account.create_wallet', 'session.signup')
            )
       SELECT (SELECT count(*) FROM members)::int AS total,
              (SELECT count(*) FROM members WHERE "createdAt" >= $1)::int AS "new",
              (SELECT count(*) FROM members m WHERE m."id" IN (SELECT id FROM active))::int AS active,
              (SELECT count(*) FROM members m
                WHERE EXISTS (SELECT 1 FROM "wallets" w WHERE w."userId" = m."id")
                   OR EXISTS (SELECT 1 FROM "mint_events" e WHERE e."ownerId" = m."id"))::int AS activated,
              (SELECT count(*) FROM members WHERE "status" = 'SUSPENDED')::int AS suspended,
              (SELECT count(*) FROM "users" WHERE "role" = 'ADMIN')::int AS admins`,
      since,
    );
    return row!;
  }

  async dataStartsAt(): Promise<Date | null> {
    const [row] = await this.db.$queryRawUnsafe<{ first: Date | null }[]>(`SELECT min("createdAt") AS first FROM "mint_events"`);
    return row?.first ?? null;
  }

  recentMints(opts: { before?: ListCursor; limit: number; ownerId?: string }): Promise<PlatformMintRow[]> {
    const b = beforeClause('e', opts.before, 2);
    const values: unknown[] = [opts.limit, ...b.values];
    let owner = 'TRUE';
    if (opts.ownerId) {
      values.push(opts.ownerId);
      owner = `e."ownerId" = $${values.length}`;
    }
    return this.db.$queryRawUnsafe<PlatformMintRow[]>(
      `SELECT e."id", e."ownerId", u."displayName" AS "ownerName", e."walletAddress", e."chainId", e."contractAddress" AS contract,
              e."kind"::text AS kind, e."quantity", e."source"::text AS source, e."status"::text AS status,
              e."failureReason", e."failureNote", e."txHash", e."createdAt"
         FROM "mint_events" e LEFT JOIN "users" u ON u."id" = e."ownerId"
        WHERE ${b.sql} AND ${owner} ORDER BY e."createdAt" DESC, e."id" DESC LIMIT $1`,
      ...values,
    );
  }

  members(opts: { before?: ListCursor; limit: number }): Promise<MemberRow[]> {
    const b = beforeClause('u', opts.before, 2);
    return this.db.$queryRawUnsafe<MemberRow[]>(
      `SELECT u."id", u."displayName", u."role"::text AS role, u."status"::text AS status, u."createdAt",
              COALESCE((SELECT array_agg(s."address" ORDER BY s."addedAt") FROM "sign_in_wallets" s WHERE s."userId" = u."id"), '{}') AS "signInAddresses",
              (SELECT count(*) FROM "wallets" w WHERE w."userId" = u."id")::int AS wallets,
              (SELECT count(*) FROM "mint_events" e WHERE e."ownerId" = u."id")::int AS mints,
              (SELECT max(e."createdAt") FROM "mint_events" e WHERE e."ownerId" = u."id") AS "lastMintAt"
         FROM "users" u WHERE ${b.sql} ORDER BY u."createdAt" DESC, u."id" DESC LIMIT $1`,
      opts.limit,
      ...b.values,
    );
  }

  audit(opts: { before?: ListCursor; limit: number; prefixes?: readonly string[]; userId?: string }): Promise<AuditRow[]> {
    const b = beforeClause('a', opts.before, 2);
    const values: unknown[] = [opts.limit, ...b.values];
    let filter = 'TRUE';
    if (opts.prefixes && opts.prefixes.length > 0) {
      values.push(opts.prefixes.map((p) => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
      filter = `a."action" LIKE ANY ($${values.length}::text[])`;
    }
    if (opts.userId) {
      values.push(opts.userId);
      filter += ` AND (a."actorUserId" = $${values.length} OR a."targetUserId" = $${values.length})`;
    }
    return this.db.$queryRawUnsafe<AuditRow[]>(
      `SELECT a."id", a."createdAt", a."action", a."actorType"::text AS "actorType", a."actorUserId", u."displayName" AS "actorName",
              a."targetUserId", a."walletId", a."outcome"::text AS outcome, a."detail"
         FROM "audit_log" a LEFT JOIN "users" u ON u."id" = a."actorUserId"
        WHERE ${b.sql} AND ${filter} ORDER BY a."createdAt" DESC, a."id" DESC LIMIT $1`,
      ...values,
    );
  }

  async memberDetail(userId: string, limit: number): Promise<MemberDetail> {
    const [signInWallets, wallets, mintCounts, recentMints, audit] = await Promise.all([
      this.db.$queryRawUnsafe<MemberDetail['signInWallets']>(
        `SELECT "address", "addedAt", "lastUsedAt" FROM "sign_in_wallets" WHERE "userId" = $1 ORDER BY "addedAt"`,
        userId,
      ),
      this.db.$queryRawUnsafe<MemberDetail['wallets']>(
        `SELECT "id", "address", "label", "tier"::text AS tier, "status"::text AS status, "origin"::text AS origin, "createdAt"
           FROM "wallets" WHERE "userId" = $1 ORDER BY "createdAt"`,
        userId,
      ),
      this.db.$queryRawUnsafe<StatusCount[]>(
        `SELECT "status"::text AS status, "failureReason", count(*)::int AS count FROM "mint_events" WHERE "ownerId" = $1 GROUP BY 1, 2`,
        userId,
      ),
      this.recentMints({ limit, ownerId: userId }),
      this.audit({ limit, userId }),
    ]);
    return { signInWallets, wallets, mintCounts, recentMints, audit };
  }
}
