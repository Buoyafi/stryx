import { randomUUID } from 'node:crypto';
import type { EventBus } from '@stryx/event-bus';
import type { Logger } from '@stryx/logger';
import { redactUrls } from '@stryx/utils';
import type { AuditLogEntry, AuditLogRepository } from './audit-log-repository.js';

/**
 * ADR-002 §3.10: records every wallet-affecting action. What makes the record tamper-resistant is the
 * database: the app's runtime role cannot UPDATE or DELETE audit_log. Each entry is also published to
 * the event bus.
 */
export class AuditLogService {
  constructor(
    private readonly repository: AuditLogRepository,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    /**
     * The role of a signed-in account ('ADMIN', 'USER'), or null to leave an entry as its caller wrote
     * it (the reserved operator, or an account that is gone).
     */
    private readonly roleOf?: (userId: string) => Promise<string | null>,
  ) {}

  /** Never throws: a failure to record must not fail the action it describes. */
  async record(rawEntry: AuditLogEntry): Promise<void> {
    // The audit table is append-only, so anything written here is permanent: URLs are removed first.
    let entry: AuditLogEntry = rawEntry.detail ? { ...rawEntry, detail: redactUrls(rawEntry.detail) } : rawEntry;
    if (this.roleOf && entry.actorUserId && entry.actorType !== 'system') {
      try {
        const role = await this.roleOf(entry.actorUserId);
        if (role !== null) entry = { ...entry, actorType: role === 'ADMIN' ? 'admin' : 'user' };
      } catch (err) {
        // The entry is still written, as the caller described it.
        this.logger.error('could not read the role for an audit entry', { action: entry.action, message: err instanceof Error ? err.message : String(err) });
      }
    }
    try {
      await this.repository.create(entry);
    } catch (err) {
      this.logger.error('failed to write audit log entry', {
        action: entry.action,
        walletId: entry.walletId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await this.eventBus.publish({
        type: `audit.${entry.action}`,
        version: 1,
        payload: entry,
        timestamp: new Date().toISOString(),
        correlationId: randomUUID(),
      });
    } catch (err) {
      this.logger.error('failed to publish audit log event', {
        action: entry.action,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
