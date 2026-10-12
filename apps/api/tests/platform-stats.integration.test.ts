import { afterAll, describe, expect, it } from 'vitest';
import { getPrismaClient, disconnectPrisma } from '@stryx/database';
import { PrismaPlatformStatsRepository, chainSummaries, mintTotals, timeSeries } from '../src/platform-stats.js';

/** The Overview's SQL, run for real as the app role (stryx_app): it has to be both right and allowed. */
const url = process.env['SIGNED_MINT_PG_TEST_URL'];

describe.skipIf(!url)('operator Overview SQL against real Postgres as stryx_app', () => {
  const prisma = getPrismaClient(url);
  const repo = new PrismaPlatformStatsRepository(prisma);
  const tag = `ov-${Date.now()}`;
  let base = new Date(Date.UTC(2100, 0, 1));
  const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
  const alice = `${tag}-alice`;
  const bob = `${tag}-bob`;
  const NFT = '0xC62CABA0cf5774D8E40e2651e86a0014de8AB768';

  const mint = (ownerId: string, minutes: number, status: string, extra: Record<string, unknown> = {}) =>
    prisma.mintEvent.create({
      data: { ownerId, walletId: `${ownerId}-w`, walletAddress: '0x' + '1'.repeat(40), chainId: 8453, contractAddress: NFT, kind: 'PUBLIC', quantity: 1, source: 'MANUAL', status: status as never, createdAt: at(minutes), ...extra },
    });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" LIKE '${tag}%'`).catch(() => undefined);
    await disconnectPrisma();
  });

  it('counts mints by status and reason, by chain with exact gas, by source and by collection', async () => {
    const newest = await prisma.mintEvent.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (newest && newest.createdAt >= base) base = new Date(newest.createdAt.getTime() + 86_400_000);
    await prisma.user.create({ data: { id: alice, role: 'USER', status: 'ACTIVE', spendCapEnabled: true, displayName: 'Alice', createdAt: at(0) } });
    await prisma.user.create({ data: { id: bob, role: 'USER', status: 'ACTIVE', spendCapEnabled: true, createdAt: at(1) } });
    await mint(alice, 10, 'CONFIRMED', { feeWei: '1000000000000000000000001', txHash: '0xa1' });
    await mint(alice, 11, 'BLOCKED', { failureReason: 'not_eligible' });
    await mint(bob, 12, 'REVERTED', { feeWei: '7', txHash: '0xb1' });
    await mint(bob, 13, 'PENDING', { txHash: '0xb2', source: 'SCHEDULED' });
    await prisma.auditLog.create({ data: { actorUserId: bob, actorType: 'USER', action: 'session.login_wallet', outcome: 'SUCCESS', createdAt: at(14) } });

    const since = at(5);
    const totals = mintTotals(await repo.mintStatusCounts(since));
    expect(totals).toMatchObject({ settled: 3, confirmed: 1, reverted: 1, blocked: 1, pending: 1, failures: { USER: 1, CHAIN: 1 } });
    const [chain] = chainSummaries(await repo.mintsByChain(since));
    expect(chain).toMatchObject({ chainId: 8453, settled: 3, pending: 1, feeWei: '1000000000000000000000008', burnedWei: '7' });
    expect(await repo.mintsBySource(since)).toEqual(expect.arrayContaining([{ source: 'MANUAL', count: 3 }, { source: 'SCHEDULED', count: 1 }]));
    // Bucketed by UTC hour and day in Postgres, then laid out like the chart draws them.
    const hours = await repo.mintTimeseries(since, 'hour');
    expect(hours.reduce((n, r) => n + r.count, 0)).toBe(4);
    expect(hours.every((r) => r.bucket.getTime() % 3_600_000 === 0)).toBe(true);
    const days = timeSeries('24h', at(30).getTime(), hours, at(10));
    expect(days.buckets.reduce((n, b) => n + b.confirmed + b.failed + b.pending, 0)).toBe(4);
    expect((await repo.mintTimeseries(since, 'day')).every((r) => r.bucket.getTime() % 86_400_000 === 0)).toBe(true);
    expect(await repo.topCollections(since, 5)).toEqual([{ chainId: 8453, contract: NFT.toLowerCase(), mints: 3, confirmed: 1, members: 2 }]);
  });

  it('counts members: new in the window, and active by minting or signing in', async () => {
    const counts = await repo.memberCounts(at(0));
    expect(counts).toMatchObject({ new: 2, active: 2 });
    expect(counts.total).toBeGreaterThanOrEqual(2);
    expect(counts.admins).toBeGreaterThanOrEqual(1);
    expect((await repo.memberCounts(at(20))).new).toBe(0);
  });

  it('lists mints, members and the audit log newest first, with names, and pages without gaps', async () => {
    // Walk pages of 2 (earlier runs' rows may come first) until this run's 4 have all been seen.
    const seen: { id: string; ownerId: string; status: string; ownerName: string | null }[] = [];
    let before: { at: Date; id: string } | undefined;
    for (let i = 0; i < 500 && seen.filter((m) => m.ownerId.startsWith(tag)).length < 4; i++) {
      const page = await repo.recentMints({ limit: 2, ...(before ? { before } : {}) });
      if (page.length === 0) break;
      seen.push(...page);
      before = { at: page[page.length - 1]!.createdAt, id: page[page.length - 1]!.id };
    }
    expect(new Set(seen.map((m) => m.id)).size).toBe(seen.length); // no row twice
    const mine = seen.filter((m) => m.ownerId.startsWith(tag));
    expect(mine.map((m) => m.status)).toEqual(['PENDING', 'REVERTED', 'BLOCKED', 'CONFIRMED']);
    expect(mine.find((m) => m.ownerId === alice)!.ownerName).toBe('Alice');

    const members = (await repo.members({ limit: 200 })).filter((m) => m.id.startsWith(tag));
    expect(members.map((m) => m.id)).toEqual([bob, alice]);
    expect(members[1]).toMatchObject({ displayName: 'Alice', mints: 2, wallets: 0, signInAddresses: [] });

    const signIns = await repo.audit({ limit: 200, prefixes: ['session.'] });
    expect(signIns.find((a) => a.actorUserId === bob)).toMatchObject({ action: 'session.login_wallet', outcome: 'SUCCESS' });
    expect(signIns.every((a) => a.action.startsWith('session.'))).toBe(true);
    expect((await repo.audit({ limit: 5, prefixes: ['nothing_like_this_%'] })).length).toBe(0); // % is literal, not a wildcard
  });

  it("gathers one member's page: sign-in wallets, mint counts, their mints and their audit entries only", async () => {
    const d = await repo.memberDetail(bob, 10);
    expect(d.signInWallets).toEqual([]);
    expect(d.wallets).toEqual([]);
    expect(mintTotals(d.mintCounts)).toMatchObject({ settled: 1, reverted: 1, pending: 1 });
    expect(d.recentMints.map((m) => m.ownerId)).toEqual([bob, bob]);
    expect(d.audit.map((a) => a.action)).toEqual(['session.login_wallet']);
    expect((await repo.memberDetail(alice, 10)).audit).toEqual([]);
  });

  it('suspends and reactivates through the status column the app may write', async () => {
    await prisma.user.updateMany({ where: { id: alice }, data: { status: 'SUSPENDED' } });
    expect((await prisma.user.findUnique({ where: { id: alice } }))!.status).toBe('SUSPENDED');
    await prisma.user.updateMany({ where: { id: alice }, data: { status: 'ACTIVE' } });
  });
});
