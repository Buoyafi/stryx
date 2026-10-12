import { randomUUID } from 'node:crypto';
import type { WaitlistRepository, WaitlistRow, WaitlistStatus } from '../../src/waitlist.js';

/** The waitlist table in memory, with the same unique-by-lowercased-email rule. */
export class InMemoryWaitlistRepository implements WaitlistRepository {
  readonly rows: (WaitlistRow & { emailLower: string })[] = [];
  private clock = 0;

  async addIfNew(email: string, emailLower: string): Promise<boolean> {
    if (this.rows.some((r) => r.emailLower === emailLower)) return false;
    this.rows.push({ id: randomUUID(), email, emailLower, status: 'WAITING', note: null, invitedAt: null, createdAt: new Date(Date.UTC(2026, 9, 2, 12, 0, this.clock++)) });
    return true;
  }

  async list(filter: { status?: WaitlistStatus; limit: number }): Promise<WaitlistRow[]> {
    return this.rows
      .filter((r) => !filter.status || r.status === filter.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit)
      .map(({ emailLower: _unused, ...row }) => row);
  }

  async counts() {
    return { waiting: this.rows.filter((r) => r.status === 'WAITING').length, invited: this.rows.filter((r) => r.status === 'INVITED').length };
  }

  async setInvited(id: string, invited: boolean, at: Date): Promise<WaitlistRow | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.status = invited ? 'INVITED' : 'WAITING';
    row.invitedAt = invited ? at : null;
    const { emailLower: _unused, ...out } = row;
    return out;
  }

  async claimForInvite(id: string, at: Date): Promise<WaitlistRow | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.status !== 'WAITING') return null;
    return this.setInvited(id, true, at);
  }

  async remove(id: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.rows.splice(i, 1);
    return true;
  }
}
