import { useEffect, useMemo, useRef } from 'react';
import { mintFeedStore, useMintFeed } from './mint-feed-store';
import { lowerHash, scheduledOutcomeRecords } from './mint-ops';
import { pendingTargets, processRound, RECEIPT_POLL_MS } from './receipt-watch';
import { useScheduledMints } from './scheduled-mints';

/** Mounted once at the app root. */
export function useMintWatcher(): void {
  const { data } = useScheduledMints({ drive: true });
  const feed = useMintFeed();

  const targets = useMemo(
    () => pendingTargets({ device: feed.device, jobs: data?.jobs ?? [], receipts: feed.receipts, unconfirmed: feed.unconfirmed }),
    [feed.device, feed.receipts, feed.unconfirmed, data?.jobs],
  );
  // The server forgets finished jobs after 24 hours.
  useEffect(() => {
    if (data?.jobs) mintFeedStore.recordScheduled(scheduledOutcomeRecords(data.jobs));
  }, [data?.jobs]);

  const latest = useRef(targets);
  latest.current = targets;
  const lookedUp = useRef(new Set<string>());
  const key = targets.map((t) => lowerHash(t.hash)).sort().join(',');

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const current = latest.current;
      for (const t of current) lookedUp.current.add(lowerHash(t.hash));
      let remaining = current.length;
      try {
        remaining = await processRound({ store: mintFeedStore, targets: current });
      } catch {
        // Keep going: a failed round is retried on the next tick.
      }
      if (!cancelled && remaining > 0) timer = setTimeout(tick, RECEIPT_POLL_MS);
    };

    // A hash never looked up before is checked straight away; otherwise wait a full interval.
    const fresh = latest.current.some((t) => !lookedUp.current.has(lowerHash(t.hash)));
    timer = setTimeout(tick, fresh ? 0 : RECEIPT_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);
}
