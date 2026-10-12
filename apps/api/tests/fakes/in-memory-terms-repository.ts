import type { AcceptanceRow, AcceptanceSource, TermsRepository, TermsVersions } from '../../src/terms.js';

export interface StoredAcceptance extends AcceptanceRow {
  userId: string;
  source: AcceptanceSource;
  ipHash: string | null;
  userAgent: string | null;
}

/** The terms_acceptances table in memory: append-only, like the real one's privileges. */
export class InMemoryTermsRepository implements TermsRepository {
  readonly rows: StoredAcceptance[] = [];

  async findAcceptance(userId: string, versions: TermsVersions): Promise<AcceptanceRow | null> {
    const hit = this.rows.filter((r) => r.userId === userId && r.termsVersion === versions.termsVersion && r.privacyVersion === versions.privacyVersion).sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime())[0];
    return hit ? { termsVersion: hit.termsVersion, privacyVersion: hit.privacyVersion, acceptedAt: hit.acceptedAt } : null;
  }

  async record(entry: TermsVersions & { userId: string; source: AcceptanceSource; ipHash: string | null; userAgent: string | null; acceptedAt: Date }): Promise<void> {
    this.rows.push({ ...entry });
  }
}
