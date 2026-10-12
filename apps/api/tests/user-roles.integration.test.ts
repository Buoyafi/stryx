import { afterAll, describe, expect, it } from 'vitest';
import { getPrismaClient, disconnectPrisma } from '@stryx/database';

/**
 * Real Postgres as the app role (stryx_app): an account's role can only be changed by the operator
 * scripts, never by the running app.
 */
const url = process.env['SIGNED_MINT_PG_TEST_URL'];

describe.skipIf(!url)('who may change a role, against real Postgres as stryx_app', () => {
  const prisma = getPrismaClient(url);
  const id = `role-test-${Date.now()}`;

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = '${id}'`).catch(() => undefined);
    await disconnectPrisma();
  });

  it('the app creates member accounts and saves their profile as before', async () => {
    await prisma.user.create({ data: { id, email: null, passwordHash: null, role: 'USER', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: true } });
    await prisma.user.updateMany({ where: { id }, data: { displayName: 'Tolu', xHandle: 'tolu' } });
    expect(await prisma.user.findUnique({ where: { id } })).toMatchObject({ displayName: 'Tolu', role: 'USER' });
  });

  it('the app cannot promote an account, by update or by creating one as ADMIN', async () => {
    await expect(prisma.user.updateMany({ where: { id }, data: { role: 'ADMIN' } })).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "users" SET "role" = 'ADMIN' WHERE "id" = '${id}'`)).rejects.toThrow(/permission denied/);
    await expect(
      prisma.user.create({ data: { id: `${id}-admin`, email: null, passwordHash: null, role: 'ADMIN', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: true } }),
    ).rejects.toThrow(/cannot create an account with role ADMIN/);
    expect((await prisma.user.findUnique({ where: { id } }))!.role).toBe('USER');
  });

  it('nor rewrite an email or password hash', async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE "users" SET "passwordHash" = 'x' WHERE "id" = '${id}'`)).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "users" SET "email" = 'x@y.z' WHERE "id" = '${id}'`)).rejects.toThrow(/permission denied/);
  });
});
