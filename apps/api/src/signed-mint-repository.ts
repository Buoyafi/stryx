/** Persistence for the signed-mint event log (`signed_mint_runs`, `signed_mint_attempts`). */
export interface SignedMintRunRow {
  jobId: string;
  ownerId: string;
  chainId: number;
  contract: string;
  slug: string;
  stageUuid: string;
  stageLabel: string;
  t0: Date;
  dryRun: boolean;
  simulate: boolean;
  rehearsal: boolean;
  status: string;
  clockSkewed: boolean | null;
  clockSummary: string | null;
  notes: string | null;
  warmupAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export type AttemptStatus = 'pending' | 'skipped' | 'failed' | 'dry_run_ok' | 'broadcast' | 'confirmed' | 'reverted';

export interface SignedMintAttemptRow {
  jobId: string;
  ownerId: string;
  walletId: string;
  walletAddress: string;
  quantity: number;
  status: AttemptStatus;
  reason: string | null;
  detail: string | null;
  txHash: string | null;
  nonce: number | null;
  blockNumber: string | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  valueWei: string | null;
  calldataMs: number | null;
  simulatedMs: number | null;
  simulateDurationMs: number | null;
  signedMs: number | null;
  broadcastMs: number | null;
  confirmedMs: number | null;
  notActiveCount: number;
  rateLimitedCount: number;
  errorCount: number;
  /** Every request made to OpenSea's mint endpoint for this wallet, whatever the answer. */
  requestCount: number;
  updatedAt?: Date;
}

export type AttemptPatch = Partial<Omit<SignedMintAttemptRow, 'jobId' | 'walletId' | 'ownerId' | 'walletAddress' | 'quantity'>>;
export type RunPatch = Partial<Pick<SignedMintRunRow, 'status' | 'clockSkewed' | 'clockSummary' | 'notes' | 'warmupAt' | 'finishedAt' | 't0'>>;

export interface SignedMintRepository {
  upsertRun(run: Omit<SignedMintRunRow, 'createdAt' | 'clockSkewed' | 'clockSummary' | 'notes' | 'warmupAt' | 'finishedAt'>): Promise<void>;
  updateRun(jobId: string, patch: RunPatch): Promise<void>;
  getRun(jobId: string): Promise<SignedMintRunRow | null>;
  /** Creates the row on first sight; later calls only apply `patch`. */
  upsertAttempt(identity: Pick<SignedMintAttemptRow, 'jobId' | 'ownerId' | 'walletId' | 'walletAddress' | 'quantity'>, patch: AttemptPatch): Promise<void>;
  listAttempts(jobId: string): Promise<SignedMintAttemptRow[]>;
}

/** Loose on purpose (`Record<string, unknown>`), same as VaultSettingPrismaDelegate: Prisma's own generics accept these. */
export interface SignedMintRunDelegate {
  upsert(args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<unknown>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown | null>;
}

export interface SignedMintAttemptDelegate {
  upsert(args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<unknown>;
  findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }): Promise<unknown[]>;
}

export class PrismaSignedMintRepository implements SignedMintRepository {
  constructor(
    private readonly runs: SignedMintRunDelegate,
    private readonly attempts: SignedMintAttemptDelegate,
  ) {}

  async upsertRun(run: Parameters<SignedMintRepository['upsertRun']>[0]): Promise<void> {
    const { jobId, ...rest } = run;
    await this.runs.upsert({ where: { jobId }, create: run, update: rest });
  }

  async updateRun(jobId: string, patch: RunPatch): Promise<void> {
    await this.runs.update({ where: { jobId }, data: patch });
  }

  async getRun(jobId: string): Promise<SignedMintRunRow | null> {
    return ((await this.runs.findUnique({ where: { jobId } })) as SignedMintRunRow | null) ?? null;
  }

  async upsertAttempt(identity: Parameters<SignedMintRepository['upsertAttempt']>[0], patch: AttemptPatch): Promise<void> {
    await this.attempts.upsert({
      where: { jobId_walletId: { jobId: identity.jobId, walletId: identity.walletId } },
      create: { status: 'pending', ...identity, ...patch },
      update: patch,
    });
  }

  async listAttempts(jobId: string): Promise<SignedMintAttemptRow[]> {
    return (await this.attempts.findMany({ where: { jobId }, orderBy: { createdAt: 'asc' } })) as SignedMintAttemptRow[];
  }
}

/** Test and fallback implementation. */
export class InMemorySignedMintRepository implements SignedMintRepository {
  readonly runs = new Map<string, SignedMintRunRow>();
  readonly attempts = new Map<string, SignedMintAttemptRow>();

  async upsertRun(run: Parameters<SignedMintRepository['upsertRun']>[0]): Promise<void> {
    const existing = this.runs.get(run.jobId);
    this.runs.set(run.jobId, {
      clockSkewed: null,
      clockSummary: null,
      notes: null,
      warmupAt: null,
      finishedAt: null,
      createdAt: new Date(),
      ...existing,
      ...run,
    });
  }

  async updateRun(jobId: string, patch: RunPatch): Promise<void> {
    const existing = this.runs.get(jobId);
    if (!existing) throw new Error(`no run ${jobId}`);
    this.runs.set(jobId, { ...existing, ...patch });
  }

  async getRun(jobId: string): Promise<SignedMintRunRow | null> {
    return this.runs.get(jobId) ?? null;
  }

  async upsertAttempt(identity: Parameters<SignedMintRepository['upsertAttempt']>[0], patch: AttemptPatch): Promise<void> {
    const key = `${identity.jobId}:${identity.walletId}`;
    const existing = this.attempts.get(key);
    this.attempts.set(
      key,
      existing
        ? { ...existing, ...patch }
        : {
            status: 'pending',
            reason: null,
            detail: null,
            txHash: null,
            nonce: null,
            blockNumber: null,
            gasUsed: null,
            effectiveGasPriceWei: null,
            valueWei: null,
            calldataMs: null,
            simulatedMs: null,
            simulateDurationMs: null,
            signedMs: null,
            broadcastMs: null,
            confirmedMs: null,
            notActiveCount: 0,
            rateLimitedCount: 0,
            errorCount: 0,
            requestCount: 0,
            ...identity,
            ...patch,
          },
    );
  }

  async listAttempts(jobId: string): Promise<SignedMintAttemptRow[]> {
    return [...this.attempts.values()].filter((a) => a.jobId === jobId);
  }
}
