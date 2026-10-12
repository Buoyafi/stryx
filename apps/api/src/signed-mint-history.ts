import type { Logger } from '@stryx/logger';
import type { SignedMintRepository } from './signed-mint-repository.js';
import { safeNote, type MintEventRepository } from './mint-event-log.js';

/** Copies a finished signed-mint run into the mint log, one row per wallet, so it shows in Mint history like any other mint. */
export async function copySignedRunToMintLog(deps: { signed: SignedMintRepository; mintLog: MintEventRepository; logger: Logger }, jobId: string): Promise<number> {
  const run = await deps.signed.getRun(jobId);
  if (!run || run.dryRun) return 0;
  if (await deps.mintLog.hasJob(jobId)) return 0;
  let copied = 0;
  for (const a of await deps.signed.listAttempts(jobId)) {
    if (a.status === 'dry_run_ok') continue;
    const base = {
      ownerId: run.ownerId,
      walletId: a.walletId,
      walletAddress: a.walletAddress,
      chainId: run.chainId,
      contractAddress: run.contract,
      kind: 'SIGNED' as const,
      quantity: a.quantity,
      source: 'SCHEDULED' as const,
      jobId,
      valueWei: a.valueWei,
      createdAt: run.t0,
    };
    try {
      if (a.txHash && (a.status === 'broadcast' || a.status === 'confirmed' || a.status === 'reverted')) {
        const id = await deps.mintLog.insert({ ...base, status: 'PENDING', txHash: a.txHash, nonce: a.nonce, broadcastAt: new Date(run.t0.getTime() + (a.broadcastMs ?? 0)) });
        if (a.status !== 'broadcast') {
          const fee = a.gasUsed && a.effectiveGasPriceWei ? (BigInt(a.gasUsed) * BigInt(a.effectiveGasPriceWei)).toString() : null;
          await deps.mintLog.settle(id, {
            status: a.status === 'confirmed' ? 'CONFIRMED' : 'REVERTED',
            blockNumber: a.blockNumber,
            gasUsed: a.gasUsed,
            effectiveGasPriceWei: a.effectiveGasPriceWei,
            feeWei: fee,
            settledAt: new Date(run.t0.getTime() + (a.confirmedMs ?? a.broadcastMs ?? 0)),
          });
        }
      } else {
        // Never sent: skipped, failed before sending, or left unfinished when the run ended.
        await deps.mintLog.insert({ ...base, status: 'BLOCKED', failureReason: a.status === 'pending' ? 'interrupted' : (a.reason ?? a.status), failureNote: safeNote(a.detail) });
      }
      copied++;
    } catch (err) {
      deps.logger.error('mint log: could not copy a signed-mint attempt', { jobId, walletId: a.walletId, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return copied;
}
