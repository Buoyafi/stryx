import { afterAll, describe, expect, it } from 'vitest';
import { getPrismaClient, disconnectPrisma } from '@stryx/database';
import { PrismaMintEventRepository, type MintEventDelegate } from '../src/mint-event-log.js';

/**
 * Real Postgres as the app's runtime role (stryx_app): the mint log's guarantees are enforced by the
 * database, so they are tested against it.
 */
const url = process.env['SIGNED_MINT_PG_TEST_URL'];

describe.skipIf(!url)('mint event log against real Postgres as stryx_app', () => {
  const prisma = getPrismaClient(url);
  const repo = new PrismaMintEventRepository(prisma.mintEvent as unknown as MintEventDelegate);
  const owner = `mint-log-test-${Date.now()}`;
  const base = { ownerId: owner, walletId: 'w1', walletAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', chainId: 4663, contractAddress: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768', kind: 'PUBLIC' as const, quantity: 2, source: 'MANUAL' as const, jobId: null, valueWei: '115792089237316195423570985008687907853269984665640564039457584007913129639935' };

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('records, signs and settles a mint, keeping 256-bit amounts and block numbers exact', async () => {
    const id = await repo.insert({ ...base, status: 'SENDING' });
    await repo.update(id, { status: 'PENDING', txHash: '0xabc', nonce: 3, broadcastAt: new Date() });
    await repo.settle(id, { status: 'CONFIRMED', blockNumber: '9007199254740993', gasUsed: '120000', effectiveGasPriceWei: '1000000001', feeWei: '120000000120000', settledAt: new Date() });
    expect(await repo.get(id)).toMatchObject({ status: 'CONFIRMED', txHash: '0xabc', nonce: 3, blockNumber: '9007199254740993', feeWei: '120000000120000', valueWei: base.valueWei });
    const [listed] = await repo.listForOwner(owner, { limit: 5 });
    expect(listed!.id).toBe(id);
    expect(await repo.firstCreatedAt(owner)).toEqual(listed!.createdAt);
  });

  it('pages by (createdAt, id), so rows from one millisecond are neither skipped nor repeated', async () => {
    const pager = `${owner}-pager`;
    const at = new Date();
    for (let i = 0; i < 5; i++) await repo.insert({ ...base, ownerId: pager, status: 'BLOCKED', failureReason: 'x', createdAt: at });
    const seen: string[] = [];
    let before: { at: Date; id: string } | undefined;
    for (;;) {
      const page = await repo.listForOwner(pager, { limit: 2, ...(before ? { before } : {}) });
      seen.push(...page.map((r) => r.id));
      if (page.length < 2) break;
      before = { at: page[1]!.createdAt, id: page[1]!.id };
    }
    expect(new Set(seen).size).toBe(5);
  });

  it('the app role cannot delete a row or rewrite who, what or where', async () => {
    const id = await repo.insert({ ...base, status: 'BLOCKED', failureReason: 'no_active_public_stage' });
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "mint_events" WHERE "id" = '${id}'`)).rejects.toThrow(/permission denied/);
    for (const col of ['"ownerId"', '"walletAddress"', '"contractAddress"', '"valueWei"', '"createdAt"']) {
      const value = col === '"createdAt"' ? 'now()' : col === '"valueWei"' ? '1' : `'x'`;
      await expect(prisma.$executeRawUnsafe(`UPDATE "mint_events" SET ${col} = ${value} WHERE "id" = '${id}'`)).rejects.toThrow(/permission denied/);
    }
  });

  it('the trigger refuses a status going backwards or out of a final state', async () => {
    const blocked = await repo.insert({ ...base, status: 'BLOCKED', failureReason: 'x' });
    await expect(repo.update(blocked, { status: 'PENDING' })).rejects.toThrow(/BLOCKED/);
    const pending = await repo.insert({ ...base, status: 'SENDING' });
    await repo.update(pending, { status: 'PENDING', txHash: '0xdef' });
    await expect(repo.update(pending, { status: 'SENDING' })).rejects.toThrow(/PENDING/);
    await repo.settle(pending, { status: 'DROPPED', settledAt: new Date() });
    await repo.settle(pending, { status: 'REVERTED', settledAt: new Date() }); // a dropped mint can still land
    await expect(repo.settle(pending, { status: 'CONFIRMED', settledAt: new Date() })).rejects.toThrow(/REVERTED/);
  });
});
