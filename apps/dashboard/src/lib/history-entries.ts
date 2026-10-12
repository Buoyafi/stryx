import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { buildHistory, entryFromSignedJob, isHistoricalSignedJob, type HistoryEntry } from './mint-history';
import type { FeedRow } from './mint-ops';
import { getSignedMintReport, type SignedMintJob } from './signed-mint';
import { mergeSigned } from './server-mints';

/** The most signed runs whose per-wallet report is fetched. The server keeps them for 7 days. */
export const MAX_SIGNED_REPORTS = 40;
const NONE: readonly HistoryEntry[] = [];

/** Every finished run, newest first: the feed rows and the signed runs. */
export function useHistoryEntries(rows: readonly FeedRow[], signedJobs: readonly SignedMintJob[], loggedSigned: readonly HistoryEntry[] = NONE): HistoryEntry[] {
  const finished = useMemo(
    () => signedJobs.filter(isHistoricalSignedJob).sort((a, b) => b.startMs - a.startMs).slice(0, MAX_SIGNED_REPORTS),
    [signedJobs],
  );
  const reports = useQueries({
    queries: finished.map((job) => ({
      queryKey: ['signed-mint-report', job.jobId],
      queryFn: () => getSignedMintReport(job.jobId),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  return useMemo(() => {
    const signed = finished.map((job, i) => entryFromSignedJob(job, reports[i]?.data));
    return buildHistory({ rows, signed: mergeSigned(signed, loggedSigned) });
  }, [rows, finished, reports, loggedSigned]);
}
