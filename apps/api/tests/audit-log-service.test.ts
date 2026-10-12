import { describe, expect, it } from 'vitest';
import { InProcessEventBus } from '@stryx/event-bus';
import type { DomainEvent } from '@stryx/event-bus';
import { noopLogger } from '@stryx/logger';
import { AuditLogService } from '../src/audit-log-service.js';
import type { AuditLogRepository, AuditLogEntry } from '../src/audit-log-repository.js';
import { InMemoryAuditLogRepository } from './fakes/in-memory-audit-log-repository.js';

describe('AuditLogService', () => {
  it('writes the entry to the repository', async () => {
    const repository = new InMemoryAuditLogRepository();
    const service = new AuditLogService(repository, new InProcessEventBus(), noopLogger);

    await service.record({
      actorUserId: 'user-1',
      actorType: 'user',
      action: 'wallet.create',
      walletId: 'wallet-1',
      outcome: 'success',
    });

    expect(repository.entries).toEqual([
      { actorUserId: 'user-1', actorType: 'user', action: 'wallet.create', walletId: 'wallet-1', outcome: 'success' },
    ]);
  });

  it('publishes the entry to the event bus', async () => {
    const repository = new InMemoryAuditLogRepository();
    const eventBus = new InProcessEventBus();
    const service = new AuditLogService(repository, eventBus, noopLogger);

    const received: DomainEvent<AuditLogEntry>[] = [];
    eventBus.subscribe<AuditLogEntry>('audit.mint.public', (event) => {
      received.push(event);
    });

    await service.record({ actorUserId: 'user-1', actorType: 'user', action: 'mint.public', outcome: 'success' });

    expect(received).toHaveLength(1);
    expect(received[0]!.payload.action).toBe('mint.public');
    expect(received[0]!.version).toBe(1);
    expect(received[0]!.correlationId).toBeTruthy();
  });

  it('never throws when the repository write fails: logs it, does not break the primary action', async () => {
    const failingRepository: AuditLogRepository = {
      async create() {
        throw new Error('simulated DB outage');
      },
    };
    const service = new AuditLogService(failingRepository, new InProcessEventBus(), noopLogger);

    await expect(
      service.record({ actorUserId: 'user-1', actorType: 'user', action: 'wallet.create', outcome: 'success' }),
    ).resolves.toBeUndefined();
  });

  it('never throws when the event bus publish fails', async () => {
    const repository = new InMemoryAuditLogRepository();
    const failingEventBus = {
      async publish() {
        throw new Error('simulated event bus outage');
      },
      subscribe() {
        return () => undefined;
      },
    };
    const service = new AuditLogService(repository, failingEventBus, noopLogger);

    await expect(
      service.record({ actorUserId: 'user-1', actorType: 'user', action: 'wallet.create', outcome: 'success' }),
    ).resolves.toBeUndefined();
    // The DB write still happened even though the publish failed.
    expect(repository.entries).toHaveLength(1);
  });
  describe('who acted, by what the account is', () => {
    const roles: Record<string, string | null> = { ada: 'ADMIN', mo: 'USER', operator: null };
    const build = () => {
      const repository = new InMemoryAuditLogRepository();
      const service = new AuditLogService(repository, new InProcessEventBus(), noopLogger, async (id) => roles[id] ?? null);
      return { repository, service };
    };

    it('an admin who signed in with a wallet is recorded as an admin, though the caller could only see a session', async () => {
      const { repository, service } = build();
      await service.record({ actorUserId: 'ada', actorType: 'user', action: 'wallet.create', outcome: 'success' });
      expect(repository.entries[0]!.actorType).toBe('admin');
    });

    it('a member is a user, whatever the caller wrote', async () => {
      const { repository, service } = build();
      await service.record({ actorUserId: 'mo', actorType: 'admin', action: 'wallet.create', outcome: 'success' });
      expect(repository.entries[0]!.actorType).toBe('user');
    });

    it('the operator token and system entries stay as written', async () => {
      const { repository, service } = build();
      await service.record({ actorUserId: 'operator', actorType: 'admin', action: 'wallet.create', outcome: 'success' });
      await service.record({ actorUserId: 'operator', actorType: 'user', action: 'wallet.create', outcome: 'success' });
      await service.record({ actorUserId: 'ada', actorType: 'system', action: 'mint.settle', outcome: 'success' });
      expect(repository.entries.map((e) => e.actorType)).toEqual(['admin', 'user', 'system']);
    });

    it('still writes the entry when the role cannot be read', async () => {
      const repository = new InMemoryAuditLogRepository();
      const service = new AuditLogService(repository, new InProcessEventBus(), noopLogger, async () => {
        throw new Error('database down');
      });
      await service.record({ actorUserId: 'ada', actorType: 'user', action: 'wallet.create', outcome: 'success' });
      expect(repository.entries).toHaveLength(1);
      expect(repository.entries[0]!.actorType).toBe('user');
    });
  });
});
