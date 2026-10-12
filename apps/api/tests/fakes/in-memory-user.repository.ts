import { randomUUID } from 'node:crypto';
import type { UserRepository, NewUserData, UserRecord } from '@stryx/user-service';

export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, UserRecord>();

  async create(data: NewUserData): Promise<UserRecord> {
    const now = new Date();
    const record: UserRecord = { ...data, email: data.email?.toLowerCase() ?? null, id: randomUUID(), displayName: null, discordHandle: null, xHandle: null, createdAt: now, updatedAt: now };
    this.byId.set(record.id, record);
    return record;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const target = email.toLowerCase();
    for (const record of this.byId.values()) {
      if (record.email === target) return record;
    }
    return null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async setStatus(id: string, status: UserRecord['status']): Promise<UserRecord | null> {
    const current = this.byId.get(id);
    if (!current) return null;
    const next: UserRecord = { ...current, status, updatedAt: new Date() };
    this.byId.set(id, next);
    return next;
  }

  async updateProfile(id: string, data: { displayName?: string | null; discordHandle?: string | null; xHandle?: string | null }): Promise<UserRecord | null> {
    const current = this.byId.get(id);
    if (!current) return null;
    const next: UserRecord = { ...current, ...data, updatedAt: new Date() };
    this.byId.set(id, next);
    return next;
  }

  /** Test-only: seed a row with a specific id (e.g. the reserved operator's), mirroring what the real migration does. */
  seed(record: Omit<UserRecord, 'displayName' | 'discordHandle' | 'xHandle'> & Partial<Pick<UserRecord, 'displayName' | 'discordHandle' | 'xHandle'>>): void {
    this.byId.set(record.id, { displayName: null, discordHandle: null, xHandle: null, ...record });
  }
}
