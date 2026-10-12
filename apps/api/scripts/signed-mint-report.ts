#!/usr/bin/env -S npx tsx
/** Prints a signed-mint run's per-wallet outcome and timings (ms from T-0), from the event log. */
/* eslint-disable no-console -- a CLI report: printing to stdout is its whole job. */
import 'dotenv/config';
import { getPrismaClient, disconnectPrisma } from '@stryx/database';
import { PrismaSignedMintRepository } from '../src/signed-mint-repository.js';
import { formatReport, toCsv } from '../src/signed-mint-report.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csv = args.includes('--csv');
  const jobId = args.find((a) => !a.startsWith('--'));
  const prisma = getPrismaClient(process.env['RUNTIME_DATABASE_URL'] || undefined);
  try {
    if (!jobId) {
      const runs = await prisma.signedMintRun.findMany({ orderBy: { createdAt: 'desc' }, take: 10 });
      if (runs.length === 0) {
        console.log('No signed-mint runs recorded yet.');
        return;
      }
      for (const r of runs) {
        console.log(`${r.jobId}  ${r.t0.toISOString()}  ${r.stageLabel.padEnd(10)} ${r.status.padEnd(10)} ${r.dryRun ? 'dry run' : ''}`);
      }
      return;
    }
    const repo = new PrismaSignedMintRepository(prisma.signedMintRun, prisma.signedMintAttempt);
    const run = await repo.getRun(jobId);
    if (!run) {
      console.error(`No signed-mint run ${jobId}.`);
      process.exitCode = 1;
      return;
    }
    const attempts = await repo.listAttempts(jobId);
    console.log(csv ? toCsv(run, attempts) : formatReport(run, attempts));
  } finally {
    await disconnectPrisma();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
