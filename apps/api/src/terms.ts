import { createHmac } from 'node:crypto';

/** Terms acceptance (docs/legal). */

export interface TermsVersions {
  termsVersion: string;
  privacyVersion: string;
}

export interface AcceptanceRow extends TermsVersions {
  acceptedAt: Date;
}

export type AcceptanceSource = 'sign_up' | 're_accept';

export interface TermsRepository {
  /** The newest acceptance this account made of exactly these versions, or null. */
  findAcceptance(userId: string, versions: TermsVersions): Promise<AcceptanceRow | null>;
  record(entry: TermsVersions & { userId: string; source: AcceptanceSource; ipHash: string | null; userAgent: string | null; acceptedAt: Date }): Promise<void>;
}

export interface TermsStatus {
  required: boolean;
  accepted: boolean;
  termsVersion: string | null;
  privacyVersion: string | null;
  acceptedAt: Date | null;
}

export interface AcceptMeta {
  ip: string | undefined;
  userAgent: string | undefined;
}

const MAX_USER_AGENT = 300;

export class TermsService {
  constructor(
    private readonly repository: TermsRepository,
    /** null = terms acceptance is off. */
    private readonly current: TermsVersions | null,
    /** Keys the IP hash. Without one, no IP evidence is kept. */
    private readonly secret: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get required(): boolean {
    return this.current !== null;
  }

  /** The versions in force, or null when acceptance is off (what the sign-up screen is told). */
  versions(): TermsVersions | null {
    return this.current ? { ...this.current } : null;
  }

  matches(given: { termsVersion?: unknown; privacyVersion?: unknown } | undefined | null): boolean {
    return this.current !== null && given?.termsVersion === this.current.termsVersion && given?.privacyVersion === this.current.privacyVersion;
  }

  async status(userId: string): Promise<TermsStatus> {
    if (!this.current) return { required: false, accepted: true, termsVersion: null, privacyVersion: null, acceptedAt: null };
    const row = await this.repository.findAcceptance(userId, this.current);
    return { required: true, accepted: row !== null, ...this.current, acceptedAt: row?.acceptedAt ?? null };
  }

  async hasAccepted(userId: string): Promise<boolean> {
    return (await this.status(userId)).accepted;
  }

  /** Records an acceptance of the versions in force. The caller has already checked `matches`. */
  async record(userId: string, source: AcceptanceSource, meta: AcceptMeta): Promise<void> {
    if (!this.current) return;
    await this.repository.record({
      userId,
      ...this.current,
      source,
      ipHash: this.secret && meta.ip ? createHmac('sha256', this.secret).update(`terms-ip:${meta.ip}`).digest('hex') : null,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, MAX_USER_AGENT) : null,
      acceptedAt: this.now(),
    });
  }
}

// ---- Prisma ----

type Row = Record<string, unknown>;
interface TermsDelegate {
  findFirst(args: Row): Promise<Row | null>;
  create(args: { data: Row }): Promise<Row>;
}
export interface TermsPrismaClient {
  termsAcceptance: TermsDelegate;
}

export class PrismaTermsRepository implements TermsRepository {
  constructor(private readonly prisma: TermsPrismaClient) {}

  async findAcceptance(userId: string, versions: TermsVersions): Promise<AcceptanceRow | null> {
    const row = await this.prisma.termsAcceptance.findFirst({ where: { userId, termsVersion: versions.termsVersion, privacyVersion: versions.privacyVersion }, orderBy: { acceptedAt: 'desc' } });
    return row ? { termsVersion: row['termsVersion'] as string, privacyVersion: row['privacyVersion'] as string, acceptedAt: row['acceptedAt'] as Date } : null;
  }

  async record(entry: TermsVersions & { userId: string; source: AcceptanceSource; ipHash: string | null; userAgent: string | null; acceptedAt: Date }): Promise<void> {
    await this.prisma.termsAcceptance.create({ data: { ...entry } });
  }
}
