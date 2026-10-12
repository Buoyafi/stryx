import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';
import { chainById, explorerTxUrl } from '@stryx/chains';
import { ApiError } from '../lib/api';
import { chargeLogo } from '../lib/brand';
import { formatDuration } from '../lib/countdown';
import { isFinalMinute } from '../lib/mint-ops';
import { useCollectionName } from '../lib/useCollectionName';
import { LockedIcon } from '../lib/icons';
import {
  attemptCounts,
  botTimeMs,
  botTimeSummary,
  cancelSignedMint,
  describeAttemptReason,
  getSignedMintReport,
  isUpcoming,
  newlyConfirmed,
  type SignedAttemptStatus,
  type SignedMintJob,
} from '../lib/signed-mint';
import { Notice } from './Notice';

const shortAddress = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '-');
const ms = (v: number | null) => (v === null ? '-' : `${v}`);

function appearance(job: SignedMintJob): {
  cls: 'live' | 'pending' | 'fail' | 'idle';
  label: string;
} {
  if (job.state === 'delayed' || job.state === 'waiting')
    return { cls: 'idle', label: job.dryRun ? 'dry run scheduled' : 'scheduled' };
  if (job.state === 'active')
    return { cls: 'pending', label: job.runStatus === 'warming_up' ? 'warming up' : 'minting' };
  if (job.state === 'failed') return { cls: 'fail', label: 'failed' };
  if (job.runStatus === 'cancelled' || job.runStatus === 'aborted')
    return { cls: 'idle', label: 'cancelled' };
  if (job.runStatus === 'moved') return { cls: 'idle', label: 'moved' };
  return { cls: 'live', label: 'finished' };
}

const statusCls: Record<SignedAttemptStatus, string> = {
  confirmed: 'live',
  broadcast: 'pending',
  dry_run_ok: 'live',
  pending: 'idle',
  reverted: 'fail',
  failed: 'fail',
  skipped: 'idle',
};

/** One scheduled signed mint: a countdown to the stage start, then each wallet's outcome and timings as the run reports them. */
export function SignedMintCard({
  job,
  now,
  chainName,
}: {
  job: SignedMintJob;
  now: number;
  chainName?: string;
}) {
  const { name } = useCollectionName(job.chainId, job.nftContract);
  const [confirming, setConfirming] = useState(false);
  const qc = useQueryClient();
  const upcoming = job.state === 'delayed' || job.state === 'waiting';
  const running = job.state === 'active';
  const { cls, label } = appearance(job);
  const title = name ?? `Contract ${shortAddress(job.nftContract)}`;
  const wallets = job.wallets.length;

  const report = useQuery({
    queryKey: ['signed-mint-report', job.jobId],
    queryFn: () => getSignedMintReport(job.jobId),
    enabled: !upcoming,
    // After the run, still looked at now and then while a sent mint has not settled.
    refetchInterval: (q) => (running ? 1_000 : q.state.data?.attempts.some((a) => a.status === 'broadcast' || a.status === 'pending') ? 5_000 : false),
    retry: false,
  });

  // The run just ended: one more fetch, or the card keeps the last report from mid-run.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void report.refetch();
    wasRunning.current = running;
  }, [running, report.refetch]);

  // Logo animation on a confirmation seen live: only transitions between polls count.
  const lastStatuses = useRef<Map<string, SignedAttemptStatus> | null>(null);
  useEffect(() => {
    const attempts = report.data?.attempts;
    if (!attempts) return;
    if (newlyConfirmed(lastStatuses.current, attempts).length > 0) chargeLogo();
    lastStatuses.current = new Map(attempts.map((a) => [a.walletId, a.status]));
  }, [report.data]);

  const cancel = useMutation({
    mutationFn: () => cancelSignedMint(job.jobId),
    onSuccess: () => setConfirming(false),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) setConfirming(false);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['signed-mints'] }),
  });

  const attempts = report.data?.attempts ?? [];
  const run = report.data?.run;
  const final = upcoming && isFinalMinute(now, job.startMs);

  return (
    <article
      className={`ops-card ops-card--${upcoming ? 'scheduled' : running ? 'minting' : 'finished'}${attempts.length > 0 ? ' ops-card--wide' : ''}`}
      aria-label={`${title}, ${label}`}
    >
      <header className="ops-card__head">
        <span className="ops-card__icon">
          <ChainIcon chain={viewForChainId(job.chainId, chainName)} />
        </span>
        <div className="ops-card__title">
          <h3 title={`${title} (${job.nftContract})`}>{title}</h3>
          <div className="ops-card__meta">
            <LockedIcon aria-hidden />
            <span>Signed · {job.stageLabel}</span>
            <span aria-hidden>·</span>
            <span>
              {wallets} wallet{wallets === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <span className={`pill ${cls}`}>{label}</span>
      </header>

      <div className="ops-card__body">
        {upcoming && (
          <>
            <div
              className={`ops-countdown${final ? ' is-final' : ''}`}
              role="timer"
              aria-label={`Stage opens in ${formatDuration(job.startMs - now)}`}
            >
              {formatDuration(job.startMs - now)}
            </div>
            <div className="ops-card__sub">
              until {job.rehearsal ? 'rehearsal' : 'stage opens'},{' '}
              {new Date(job.startMs).toLocaleString()} · {job.totalQuantity} NFT
              {job.totalQuantity === 1 ? '' : 's'} · warm-up 5s before
            </div>
          </>
        )}
        {!upcoming && (
          <div className="ops-card__status" style={{ fontSize: 13 }}>
            {attempts.length > 0
              ? attemptCounts(attempts)
              : running
                ? 'Warming up'
                : 'No wallet results recorded'}
          </div>
        )}
        {!upcoming && botTimeSummary(attempts) && (
          <div
            className="ops-card__sub"
            title="From OpenSea handing over the calldata to the transaction being sent: checks, simulation and signing."
          >
            {botTimeSummary(attempts)}
          </div>
        )}
      </div>

      {run?.clockSkewed && (
        <Notice tone="warn" detail={run.clockSummary ?? undefined}>
          Server clock was over 1s off at warm-up.
        </Notice>
      )}

      {attempts.length > 0 && (
        <div className="ops-card__table">
          <table className="dense" aria-label="Wallet results and timings (ms from stage start)">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Status</th>
                <th title="ms from stage start">Calldata</th>
                <th title="ms from stage start">Sent</th>
                <th title="ms from stage start">Confirmed</th>
                <th title="The bot's own time: calldata received to sent (dry run: to simulated), ms">
                  Bot time
                </th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => {
                const reason = describeAttemptReason(a.reason);
                const chain = chainById(job.chainId);
                const url = a.txHash && chain ? explorerTxUrl(chain, a.txHash) : undefined;
                return (
                  <tr key={a.walletId}>
                    <td className="mono" title={a.walletAddress || a.walletId}>
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          {shortAddress(a.walletAddress)}
                        </a>
                      ) : a.walletAddress ? (
                        shortAddress(a.walletAddress)
                      ) : (
                        a.walletId
                      )}
                    </td>
                    <td title={a.detail ?? undefined}>
                      <span className={`pill ${statusCls[a.status]}`}>
                        {a.status.replace(/_/g, ' ')}
                      </span>
                      {reason && (
                        <span style={{ color: 'var(--stryx-sub)', marginLeft: 8 }}>{reason}</span>
                      )}
                      {a.detail && (a.status === 'failed' || a.status === 'skipped') && (
                        <div className="ops-card__detail">{a.detail}</div>
                      )}
                    </td>
                    <td className="mono">{ms(a.calldataMs)}</td>
                    <td className="mono">{ms(a.broadcastMs)}</td>
                    <td className="mono">{ms(a.confirmedMs)}</td>
                    <td className="mono">{ms(botTimeMs(a))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="ops-card__foot">
        <span className="ops-card__sub">
          {job.dryRun ? (job.rehearsal ? 'Dry-run rehearsal · ' : 'Dry run · ') : ''}
          {job.simulate ? 'simulation on' : 'simulation off'}
          {attempts.length > 0 ? ' · times in ms from stage start' : ''}
        </span>
        {isUpcoming(job) && (
          <button type="button" className="danger" onClick={() => setConfirming(true)}>
            Cancel schedule
          </button>
        )}
      </footer>

      {confirming && (
        <div
          className="modal-backdrop"
          onClick={() => !cancel.isPending && setConfirming(false)}
          onKeyDown={(e) => e.key === 'Escape' && !cancel.isPending && setConfirming(false)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`cancel-signed-${job.jobId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={`cancel-signed-${job.jobId}`} style={{ fontSize: 15, marginBottom: 8 }}>
              {running ? 'Stop this run?' : 'Cancel this schedule?'}
            </h2>
            <p
              style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginBottom: 14, lineHeight: 1.6 }}
            >
              {running
                ? 'Every wallet not yet sent stops at its next check. A mint already broadcast cannot be recalled.'
                : `This deletes the scheduled ${job.stageLabel} mint for ${wallets} wallet${wallets === 1 ? '' : 's'}. Nothing will mint. It cannot be undone.`}
            </p>
            {cancel.isError && (
              <Notice tone="error">{cancel.error instanceof Error ? cancel.error.message : 'Could not cancel.'}</Notice>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirming(false)}
                disabled={cancel.isPending}
              >
                Keep it
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? 'Cancelling…' : running ? 'Stop run' : 'Cancel schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
