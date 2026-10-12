import { afterAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '@stryx/database';
import { PrismaPlatformStatsRepository } from '../src/platform-stats.js';

/** Real Postgres as the read-only analytics role: every Overview query must work with only what that role may read. */
const url = process.env['ANALYTICS_PG_TEST_URL'];

describe.skipIf(!url)('the Overview through the read-only analytics role', () => {
  // A skipped describe still runs its body while tests are collected: only build the client with a URL.
  const prisma = url ? createPrismaClient(url) : (undefined as never);
  const repo = new PrismaPlatformStatsRepository(prisma);
  const since = new Date(Date.now() - 30 * 86_400_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('every Overview and member-page query runs with only the columns this role may read', async () => {
    await repo.mintStatusCounts(since);
    await repo.mintsByChain(since);
    await repo.mintsBySource(since);
    await repo.mintTimeseries(since, 'day');
    await repo.topCollections(since, 5);
    await repo.memberCounts(since);
    await repo.dataStartsAt();
    await repo.recentMints({ limit: 5 });
    const members = await repo.members({ limit: 5 });
    await repo.audit({ limit: 5, prefixes: ['session.'] });
    if (members[0]) await repo.memberDetail(members[0].id, 5);
  });

  it('cannot write anything, or read password hashes, emails or wallet keys', async () => {
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "audit_log" ("id", "actorType", "action", "outcome") VALUES ('x', 'SYSTEM', 'x', 'SUCCESS')`)).rejects.toThrow(/read-only|permission denied/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "users" SET "status" = 'SUSPENDED'`)).rejects.toThrow(/read-only|permission denied/);
    for (const query of [`SELECT "passwordHash" FROM "users" LIMIT 1`, `SELECT "email" FROM "users" LIMIT 1`, `SELECT "encryptedPrivateKey" FROM "wallets" LIMIT 1`, `SELECT "wrappedDek" FROM "wallets" LIMIT 1`, `SELECT * FROM "access_codes" LIMIT 1`]) {
      await expect(prisma.$queryRawUnsafe(query), query).rejects.toThrow(/permission denied/);
    }
  });
});
