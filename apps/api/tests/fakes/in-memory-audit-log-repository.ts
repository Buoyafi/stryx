import type { AuditLogEntry, AuditLogRepository } from '../../src/audit-log-repository.js';

export class InMemoryAuditLogRepository implements AuditLogRepository {
  readonly entries: AuditLogEntry[] = [];

  async create(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}
