export type AuditActorType = 'user' | 'admin' | 'system';
export type AuditOutcome = 'success' | 'failure';

export interface AuditLogEntry {
  actorUserId: string | null;
  actorType: AuditActorType;
  action: string;
  walletId?: string | null;
  targetUserId?: string | null;
  outcome: AuditOutcome;
  detail?: string | null;
}

/** Persistence for AuditLog. */
export interface AuditLogPrismaDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

export interface AuditLogRepository {
  create(entry: AuditLogEntry): Promise<void>;
}

export class PrismaAuditLogRepository implements AuditLogRepository {
  constructor(private readonly auditLog: AuditLogPrismaDelegate) {}

  async create(entry: AuditLogEntry): Promise<void> {
    await this.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        actorType: entry.actorType.toUpperCase(),
        action: entry.action,
        walletId: entry.walletId ?? null,
        targetUserId: entry.targetUserId ?? null,
        outcome: entry.outcome.toUpperCase(),
        detail: entry.detail ?? null,
      },
    });
  }
}
