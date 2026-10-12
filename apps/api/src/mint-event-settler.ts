import type { Logger } from '@stryx/logger';
import type { MintCursor, MintEventRepository, MintEventRow } from './mint-event-log.js';

/**
 * Settles the mint log from the chain (ADR-003 §4.9): every PENDING row with a hash gets its receipt
 * read and becomes CONFIRMED or REVERTED, with block, gas and fee.
 */
export interface ReceiptReader {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice?: bigint | null; l1Fee?: bigint | null }>;
}

export interface SettlerOptions {
  batchSize?: number;
  dropAfterMs?: number;
  recheckDroppedForMs?: number;
  /** DROPPED rows are re-read on one pass in this many (not every pass). */
  droppedEvery?: number;
  sendingGraceMs?: number;
  now?: () => number;
}

const isNotFound = (err: unknown) => {
  const name = (err as { name?: string })?.name ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  return name === 'TransactionReceiptNotFoundError' || /could not be found|not found/i.test(msg);
};

export class MintEventSettler {
  private readonly batchSize: number;
  private readonly dropAfterMs: number;
  private readonly recheckDroppedForMs: number;
  private readonly droppedEvery: number;
  private readonly sendingGraceMs: number;
  private readonly now: () => number;
  private pass = 0;
  /** Where the last pass stopped on each chain: the next one carries on from there. */
  private readonly resumeAfter = new Map<number, MintCursor>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repository: MintEventRepository,
    private readonly readers: ReadonlyMap<number, ReceiptReader>,
    private readonly logger: Logger,
    opts: SettlerOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 50;
    this.dropAfterMs = opts.dropAfterMs ?? 6 * 3_600_000;
    this.recheckDroppedForMs = opts.recheckDroppedForMs ?? 7 * 86_400_000;
    this.droppedEvery = opts.droppedEvery ?? 120;
    this.sendingGraceMs = opts.sendingGraceMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** One pass over every chain. Returns how many rows changed. Never throws. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const includeDropped = this.pass++ % this.droppedEvery === 0;
    let changed = 0;
    try {
      const now = this.now();
      for (const stuck of await this.repository.listStuckSending(new Date(now - this.sendingGraceMs), this.batchSize)) {
        await this.repository.update(stuck.id, { status: 'BLOCKED', failureReason: 'interrupted' });
        changed++;
      }
      for (const [chainId, reader] of this.readers) {
        const droppedSince = new Date(includeDropped ? now - this.recheckDroppedForMs : now + 1);
        // One page a pass, and each pass starts where the last one stopped.
        const after = this.resumeAfter.get(chainId);
        const rows = await this.repository.listUnsettled(chainId, { limit: this.batchSize, droppedSince, ...(after ? { after } : {}) });
        for (const row of rows) changed += await this.settleOne(row, reader, now);
        const last = rows.at(-1);
        if (last && rows.length === this.batchSize) this.resumeAfter.set(chainId, { at: last.createdAt, id: last.id });
        else this.resumeAfter.delete(chainId); // reached the end: back to the oldest next time
      }
    } catch (err) {
      this.logger.error('mint log settler: pass failed', { err: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
    return changed;
  }

  private async settleOne(row: MintEventRow, reader: ReceiptReader, now: number): Promise<number> {
    try {
      const receipt = await reader.getTransactionReceipt({ hash: row.txHash as `0x${string}` });
      const price = receipt.effectiveGasPrice ?? null;
      const fee = price !== null ? receipt.gasUsed * price + (receipt.l1Fee ?? 0n) : null;
      await this.repository.settle(row.id, {
        status: receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED',
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: price !== null ? price.toString() : null,
        feeWei: fee !== null ? fee.toString() : null,
        settledAt: new Date(now),
      });
      return 1;
    } catch (err) {
      if (isNotFound(err)) {
        const since = (row.broadcastAt ?? row.createdAt).getTime();
        if (row.status === 'PENDING' && now - since > this.dropAfterMs) {
          await this.repository.settle(row.id, { status: 'DROPPED', settledAt: new Date(now) });
          return 1;
        }
        return 0; // not mined yet
      }
      // An RPC problem: try again on the next pass, change nothing.
      this.logger.warn('mint log settler: could not read a receipt', { chainId: row.chainId, err: err instanceof Error ? err.message : String(err) });
      return 0;
    }
  }

  start(intervalMs = 20_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
