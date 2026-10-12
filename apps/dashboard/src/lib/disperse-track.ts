import { RECEIPT_BATCH, RECEIPT_POLL_MS, UNCONFIRMED_AFTER_MS, fetchReceiptsFromApi, type FetchReceipts } from './receipt-watch';
import type { Receipt } from './disperse-send';

/** Follows hashes the server broadcast for us until each has a final receipt, reporting each one as it resolves. */
export async function trackReceipts(
  chainId: number,
  hashes: readonly string[],
  onReceipt: (hash: string, receipt: Receipt) => void,
  opts: { fetch?: FetchReceipts; intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; signal?: AbortSignal } = {},
): Promise<void> {
  const { fetch = fetchReceiptsFromApi, intervalMs = RECEIPT_POLL_MS, timeoutMs = UNCONFIRMED_AFTER_MS, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)), now = Date.now, signal } = opts;
  const open = new Set(hashes.map((h) => h.toLowerCase()));
  const original = new Map(hashes.map((h) => [h.toLowerCase(), h]));
  const deadline = now() + timeoutMs;

  while (open.size > 0 && !signal?.aborted) {
    const ids = [...open];
    for (let i = 0; i < ids.length; i += RECEIPT_BATCH) {
      try {
        const got = await fetch(chainId, ids.slice(i, i + RECEIPT_BATCH).map((h) => original.get(h) ?? h));
        for (const r of got) {
          const key = r.hash.toLowerCase();
          if (!open.has(key) || (r.status !== 'success' && r.status !== 'reverted')) continue;
          open.delete(key);
          onReceipt(original.get(key) ?? r.hash, { status: r.status });
        }
      } catch {
        // Not yet: the deadline below bounds it.
      }
    }
    if (open.size === 0) return;
    if (now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  if (signal?.aborted) return;
  const dropped = new Set<string>();
  const left = [...open];
  for (let i = 0; i < left.length; i += RECEIPT_BATCH) {
    try {
      const got = await fetch(chainId, left.slice(i, i + RECEIPT_BATCH).map((h) => original.get(h) ?? h), { lookup: true });
      for (const r of got) {
        const key = r.hash.toLowerCase();
        if (!open.has(key)) continue;
        if (r.status === 'success' || r.status === 'reverted') {
          open.delete(key);
          onReceipt(original.get(key) ?? r.hash, { status: r.status });
        } else if (r.status === 'not_found') dropped.add(key);
      }
    } catch {
      // No answer: these stay unknown.
    }
  }
  for (const key of open) onReceipt(original.get(key) ?? key, { status: dropped.has(key) ? 'dropped' : 'unknown' });
}
