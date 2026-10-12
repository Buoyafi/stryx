import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiRequest } from '../lib/api';
import { buildFeed, groupJobs, type MintCard, type ReceiptMap, type ScheduledJob } from '../lib/mint-ops';
import { mintFeedStore, useMintFeed } from '../lib/mint-feed-store';
import { useScheduledMints } from '../lib/scheduled-mints';
import { useNow } from '../lib/useNow';
import { MintCountdownCard } from '../components/MintCountdownCard';
import { JustFinished } from '../components/JustFinished';
import { MintHistory } from '../components/MintHistory';
import { ProofCardModal } from '../components/ProofCardModal';
import { useHistoryEntries } from '../lib/history-entries';
import type { HistoryEntry } from '../lib/mint-history';
import { SignedMintCard } from '../components/SignedMintCard';
import { isUpcoming, listSignedMints, signedRefetchInterval, type SignedMintJob } from '../lib/signed-mint';
import { Notice } from '../components/Notice';
import { feedRowsFromServer, olderLocalRows, receiptsFromServer, SERVER_MINTS_KEY, signedEntriesFromServer, useServerMints } from '../lib/server-mints';

interface WalletLite {
  id: string;
  address: string;
}
interface ChainOption {
  chainId: number;
  name: string;
}

function CardSkeletons() {
  return (
    <div className="ops-grid" aria-busy="true" aria-label="Loading scheduled mints">
      {[0, 1, 2].map((i) => (
        <div key={i} className="ops-card" aria-hidden>
          <div className="skeleton" style={{ width: '60%' }} />
          <div className="skeleton" style={{ height: 28, width: '45%' }} />
          <div className="skeleton" style={{ width: '80%' }} />
        </div>
      ))}
    </div>
  );
}

const dropKey = (c: Pick<MintCard, 'chainId' | 'nftContract'>) => `${c.chainId}:${c.nftContract.toLowerCase()}`;

/** Owns the ticking clock and the grouping, so every card's state comes from the same second as its countdown. */
function ScheduledSection({
  jobs,
  receipts,
  chainNames,
  loading,
  errorText,
  onRetry,
  hasUpcomingSigned = false,
}: {
  jobs: ScheduledJob[];
  receipts: ReceiptMap;
  chainNames: Map<number, string>;
  loading: boolean;
  errorText: string | null;
  onRetry: () => void;
  /** Signed-mint cards are showing above: then an empty list here is not "no scheduled mints". */
  hasUpcomingSigned?: boolean;
}) {
  const now = useNow(1000);
  const cards = useMemo(() => groupJobs(jobs, now, receipts), [jobs, now, receipts]);
  const upcoming = cards.filter((c) => !c.done);
  // Every still-cancellable card for the same drop, so a card can offer "Cancel all" for its drop.
  const byDrop = useMemo(() => {
    const map = new Map<string, MintCard[]>();
    for (const c of upcoming.filter((u) => u.cancellable)) map.set(dropKey(c), [...(map.get(dropKey(c)) ?? []), c]);
    return map;
  }, [upcoming]);

  if (loading) return <CardSkeletons />;
  if (errorText && jobs.length === 0) {
    return (
      <div className="empty-state">
        <Notice tone="error">{errorText}</Notice>
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (upcoming.length === 0 && hasUpcomingSigned) return null;
  if (upcoming.length === 0) {
    return (
      <div className="empty-state">
        <div style={{ marginBottom: 8 }}>No scheduled mints</div>
        <Link to="/mint">Schedule one from the Mint page</Link>
      </div>
    );
  }
  return (
    <div className="ops-grid">
      {upcoming.map((card) => (
        <MintCountdownCard
          key={card.id}
          card={card}
          now={now}
          sameDrop={byDrop.get(dropKey(card)) ?? []}
          {...(chainNames.get(card.chainId) ? { chainName: chainNames.get(card.chainId)! } : {})}
        />
      ))}
    </div>
  );
}

/** Signed-mint jobs still to come or running, one card each. */
function SignedSection({ jobs, chainNames }: { jobs: SignedMintJob[]; chainNames: Map<number, string> }) {
  const now = useNow(1000);
  if (jobs.length === 0) return null;
  return (
    <div className="ops-grid" style={{ marginBottom: 18 }}>
      {jobs.map((job) => (
        <SignedMintCard key={job.jobId} job={job} now={now} {...(chainNames.get(job.chainId) ? { chainName: chainNames.get(job.chainId)! } : {})} />
      ))}
    </div>
  );
}

export function OperationsPage() {
  const jobsQuery = useScheduledMints({ drive: false });
  const signedQuery = useQuery({
    queryKey: ['signed-mints'],
    queryFn: listSignedMints,
    refetchInterval: (q) => signedRefetchInterval(q.state.data?.jobs, Date.now()),
  });
  const feed = useMintFeed();
  const { data: wallets } = useQuery({ queryKey: ['wallets'], queryFn: () => apiRequest<WalletLite[]>('/wallets') });
  const { data: chainData } = useQuery({ queryKey: ['chains'], queryFn: () => apiRequest<{ chains: ChainOption[] }>('/chains') });

  const jobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data]);
  const signedJobs = useMemo(() => signedQuery.data?.jobs ?? [], [signedQuery.data]);
  const upcomingSigned = useMemo(() => signedJobs.filter(isUpcoming), [signedJobs]);
  const chainNames = useMemo(() => new Map((chainData?.chains ?? []).map((c) => [c.chainId, c.name])), [chainData]);
  const addressById = useMemo(() => new Map((wallets ?? []).map((w) => [w.id, w.address])), [wallets]);

  // History comes from the account's mint log, so it is the same on every device.
  const server = useServerMints();
  const serverMints = useMemo(() => server.data?.pages.flatMap((p) => p.mints) ?? [], [server.data]);
  const firstAt = server.data?.pages[0]?.firstAt;
  const noServerLog = server.isError && server.error instanceof ApiError && server.error.status === 404;
  const fromAccount = server.isSuccess;
  const local = useMemo(
    () => buildFeed({ device: feed.device, jobs, receipts: feed.receipts, unconfirmed: feed.unconfirmed, addressOf: (id) => addressById.get(id) }),
    [feed.device, feed.receipts, feed.unconfirmed, jobs, addressById],
  );
  const { rows, olderLocal } = useMemo(() => {
    if (!fromAccount) return { rows: local, olderLocal: 0 };
    const fromServer = feedRowsFromServer(serverMints, feed.receipts);
    const older = olderLocalRows(local, firstAt, fromServer);
    return { rows: [...fromServer, ...older], olderLocal: older.length };
  }, [fromAccount, serverMints, feed.receipts, local, firstAt]);
  const loggedSigned = useMemo(() => signedEntriesFromServer(serverMints, feed.receipts), [serverMints, feed.receipts]);
  // Outcomes the server already settled become this browser's receipts too (scheduled cards read them).
  useEffect(() => {
    mintFeedStore.setReceipts(receiptsFromServer(serverMints, feed.receipts));
  }, [serverMints, feed.receipts]);

  // A scheduled run that just finished is in the log: look again rather than wait for the next poll.
  const queryClient = useQueryClient();
  const finishedJobs = jobs.filter((j) => j.state === 'completed' || j.state === 'failed').length;
  const seenFinished = useRef<number | null>(null);
  useEffect(() => {
    if (jobsQuery.isSuccess && seenFinished.current !== null && finishedJobs !== seenFinished.current) void queryClient.invalidateQueries({ queryKey: SERVER_MINTS_KEY });
    if (jobsQuery.isSuccess) seenFinished.current = finishedJobs;
  }, [finishedJobs, jobsQuery.isSuccess, queryClient]);

  const entries = useHistoryEntries(rows, signedJobs, loggedSigned);
  const [proofFor, setProofFor] = useState<HistoryEntry | null>(null);
  const now = useNow(30_000);

  const errorText = jobsQuery.isError ? (jobsQuery.error instanceof Error ? jobsQuery.error.message : 'Could not load scheduled mints.') : null;

  return (
    <div>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Activity</h1>
      <p className="page-sub" style={{ color: 'var(--stryx-sub)', marginBottom: 24 }}>Scheduled mints counting down, and every mint that has run.</p>

      <section className="ops-section" aria-labelledby="ops-scheduled">
        <div className="ops-section__head">
          <h2 id="ops-scheduled">Scheduled mints</h2>
        </div>
        <p className="ops-note">Refreshes every few seconds while a mint is close, and less often otherwise.</p>

        <SignedSection jobs={upcomingSigned} chainNames={chainNames} />

        <ScheduledSection
          jobs={jobs}
          receipts={feed.receipts}
          chainNames={chainNames}
          loading={jobsQuery.isLoading}
          errorText={errorText}
          onRetry={() => jobsQuery.refetch()}
          hasUpcomingSigned={upcomingSigned.length > 0}
        />
      </section>

      <JustFinished entries={entries} now={now} chainNames={chainNames} onProof={setProofFor} />

      <section className="ops-section" aria-labelledby="ops-history">
        <div className="ops-section__head">
          <h2 id="ops-history">Mint history</h2>
        </div>
        <MintHistory
          entries={entries}
          onProof={setProofFor}
          chainNames={chainNames}
          loading={server.isLoading || (!fromAccount && jobsQuery.isLoading && feed.device.length === 0) || signedQuery.isLoading}
          error={server.isError && !noServerLog ? 'Your mint history could not be loaded. Showing what this browser kept.' : !fromAccount && errorText ? 'Scheduled jobs could not be loaded.' : null}
          scope={fromAccount ? { kind: 'account', ...(firstAt && olderLocal > 0 ? { since: Date.parse(firstAt) } : {}) } : { kind: 'device', since: feed.recordingSince }}
          {...(server.hasNextPage ? { onLoadOlder: () => void server.fetchNextPage(), loadingOlder: server.isFetchingNextPage } : {})}
        />
      </section>

      {proofFor && <ProofCardModal entry={proofFor} onClose={() => setProofFor(null)} />}
    </div>
  );
}
