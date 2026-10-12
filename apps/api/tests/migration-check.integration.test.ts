import { afterAll, describe, expect, it } from 'vitest';
import { getPrismaClient, disconnectPrisma, checkMigrations } from '@stryx/database';

/** Real Postgres as the app role (stryx_app): the check reads Prisma's migration table, which that role is granted. */
const url = process.env['SIGNED_MINT_PG_TEST_URL'];

describe.skipIf(!url)('migration check against real Postgres as stryx_app', () => {
  afterAll(async () => {
    await disconnectPrisma();
  });

  it('a fully migrated database checks out ok, read with the app role', async () => {
    const check = await checkMigrations(getPrismaClient(url));
    expect(check.status).toBe('ok');
  });
});
