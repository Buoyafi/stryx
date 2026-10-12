import { afterAll, describe, expect, it } from 'vitest';
import { getPrismaClient, disconnectPrisma } from '@stryx/database';
import { PrismaSignedMintRepository } from '../src/signed-mint-repository.js';

/**
 * Real Postgres as the app's runtime role (stryx_app): what matters is what that role may and may not
 * do to the signed-mint log.
 */
const url = process.env['SIGNED_MINT_PG_TEST_URL'];

describe.skipIf(!url)('signed-mint event log against real Postgres as stryx_app', () => {
  const prisma = getPrismaClient(url);
  const repo = new PrismaSignedMintRepository(prisma.signedMintRun, prisma.signedMintAttempt);
  const jobId = `signed-test-${Date.now()}`;

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('writes a run and a wallet row, then fills timings in place', async () => {
    await repo.upsertRun({
      jobId,
      ownerId: 'owner-1',
      chainId: 4663,
      contract: '0xc62caba0cf5774d8e40e2651e86a0014de8ab768',
      slug: 'kid-story',
      stageUuid: 'stage-1',
      stageLabel: 'FCFS',
      t0: new Date(1_790_000_000_000),
      dryRun: false,
      simulate: true,
      rehearsal: false,
      status: 'scheduled',
    });
    await repo.updateRun(jobId, { status: 'finished', clockSkewed: false, clockSummary: 'server clock vs opensea +12ms (±520ms)' });

    const identity = { jobId, ownerId: 'owner-1', walletId: 'w1', walletAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', quantity: 2 };
    await repo.upsertAttempt(identity, { status: 'pending' });
    await repo.upsertAttempt(identity, { calldataMs: -40, notActiveCount: 7 });
    await repo.upsertAttempt(identity, { status: 'confirmed', simulatedMs: 12, simulateDurationMs: 9, signedMs: 15, broadcastMs: 31, confirmedMs: 410, txHash: '0xabc', gasUsed: '120000' });

    const run = await repo.getRun(jobId);
    expect(run).toMatchObject({ status: 'finished', clockSkewed: false });
    const [attempt] = await repo.listAttempts(jobId);
    expect(attempt).toMatchObject({ status: 'confirmed', calldataMs: -40, notActiveCount: 7, simulatedMs: 12, broadcastMs: 31, confirmedMs: 410, gasUsed: '120000' });
  });

  it('the app role cannot DELETE either table', async () => {
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "signed_mint_attempts" WHERE "jobId" = '${jobId}'`)).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "signed_mint_runs" WHERE "jobId" = '${jobId}'`)).rejects.toThrow(/permission denied/);
  });
});
