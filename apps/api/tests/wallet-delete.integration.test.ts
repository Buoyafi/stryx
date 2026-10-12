import { afterAll, describe, expect, it } from 'vitest';
import { getPrismaClient, disconnectPrisma } from '@stryx/database';
import { PrismaWalletRepository } from '@stryx/wallet-service';

/** Real Postgres as the app role (stryx_app): deleting a wallet whose key was rotated also removes its rotation events. */
const url = process.env['SIGNED_MINT_PG_TEST_URL'];

describe.skipIf(!url)('deleting a wallet, against real Postgres as stryx_app', () => {
  const prisma = url ? getPrismaClient(url) : (undefined as never);
  const userId = `wallet-delete-test-${Date.now()}`;
  const walletId = `${userId}-w`;

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "wallet_key_rotation_events" WHERE "walletId" = '${walletId}'`).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DELETE FROM "wallets" WHERE "id" = '${walletId}'`).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = '${userId}'`).catch(() => undefined);
    await disconnectPrisma();
  });

  it('a wallet whose key was rotated is deleted along with its rotation history', async () => {
    await prisma.user.create({ data: { id: userId, email: null, passwordHash: null, role: 'USER', status: 'ACTIVE', dailySpendCapWei: null, spendCapEnabled: true } });
    const address = `0x${Date.now().toString(16).padStart(40, '0')}`;
    await prisma.wallet.create({
      data: { id: walletId, address, label: null, tier: 'HOT', status: 'ACTIVE', origin: 'GENERATED', userId, encryptedPrivateKey: 'x', wrappedDek: 'x', iv: 'x', authTag: 'x', keyVersion: 2, kmsKeyId: 'local' },
    });
    await prisma.walletKeyRotationEvent.create({ data: { walletId, fromVersion: 1, toVersion: 2, kmsKeyId: 'local' } });

    await new PrismaWalletRepository(prisma.wallet as never).delete(userId as never, walletId);

    expect(await prisma.wallet.findUnique({ where: { id: walletId } })).toBeNull();
    expect(await prisma.walletKeyRotationEvent.count({ where: { walletId } })).toBe(0);
  });
});
