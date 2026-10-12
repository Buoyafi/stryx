import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';
import { apiRequest, ApiError } from '../lib/api';
import { formatDuration } from '../lib/countdown';
import { isFinalMinute, stateAppearance, type MintCard, type OpsState } from '../lib/mint-ops';
import { describeMintError } from '../lib/mint-error';
import { useCollectionName } from '../lib/useCollectionName';
import { LockedIcon, UnlockedIcon } from '../lib/icons';
import { Notice } from './Notice';
import { DateTimePicker } from './DateTimePicker';

const shortContract = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "2 confirmed, 1 failed": only the non-zero parts. */
function countsLine(card: MintCard): string {
  const order: OpsState[] = ['confirmed', 'failed', 'minting', 'armed', 'scheduled', 'finished'];
  return order.filter((s) => card.counts[s] > 0).map((s) => `${card.counts[s]} ${s}`).join(', ');
}

/** "YYYY-MM-DDTHH:mm" in local time, the value DateTimePicker takes (and a datetime-local input did). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Change the quantity per wallet and/or the time for every wallet in the card. */
function EditPanel({ card, onDone }: { card: MintCard; onDone: () => void }) {
  const qc = useQueryClient();
  const sameQuantity = card.jobs.every((j) => j.quantity === card.jobs[0]!.quantity);
  const [quantity, setQuantity] = useState(sameQuantity ? String(card.jobs[0]!.quantity) : '');
  const [runsAt, setRunsAt] = useState(() => toLocalInput(card.executeAt));
  const timeChanged = runsAt !== toLocalInput(card.executeAt);
  const quantityChanged = quantity !== '' && (!sameQuantity || Number(quantity) !== card.jobs[0]!.quantity);
  const quantityOk = quantity === '' || (Number.isInteger(Number(quantity)) && Number(quantity) > 0);
  const valid = runsAt !== '' && quantityOk && (timeChanged || quantityChanged);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ...(quantityChanged ? { quantity: Number(quantity) } : {}),
        ...(timeChanged ? { executeAt: new Date(runsAt).toISOString() } : {}),
      };
      const results = await Promise.allSettled(card.jobs.map((j) => apiRequest(`/schedules/mints/${j.jobId}`, { method: 'PATCH', body })));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        const first = failed[0] as PromiseRejectedResult;
        throw new Error(`Updated ${card.jobs.length - failed.length} of ${card.jobs.length}. ${describeMintError(first.reason)}`);
      }
    },
    onSuccess: onDone,
    onSettled: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });

  return (
    <form
      className="ops-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <label>
        <span>Per wallet</span>
        <input className="mono" inputMode="numeric" value={quantity} placeholder={sameQuantity ? '' : 'as is'} onChange={(e) => setQuantity(e.target.value)} />
      </label>
      <label>
        <span>Runs at</span>
        <DateTimePicker aria-label="Runs at" value={runsAt} onChange={setRunsAt} min={() => Date.now()} allowClear={false} />
      </label>
      {save.isError && (
        <Notice tone="error">{save.error instanceof Error ? save.error.message : 'Could not save.'}</Notice>
      )}
      <div className="ops-edit__actions">
        <button type="button" onClick={onDone} disabled={save.isPending}>
          Discard
        </button>
        <button type="submit" className="primary" disabled={!valid || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/** One scheduled mint (a batch of wallets for one contract, phase and time). */
export function MintCountdownCard({
  card,
  now,
  chainName,
  sameDrop = [],
}: {
  card: MintCard;
  now: number;
  chainName?: string;
  /** Every still-cancellable card for this same drop, this one included. Two or more offers "Cancel all". */
  sameDrop?: readonly MintCard[];
}) {
  // The name lookup reads the chain, so it can be slow.
  const { name } = useCollectionName(card.chainId, card.nftContract);
  const [confirming, setConfirming] = useState<'card' | 'drop' | null>(null);
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const { cls, label } = stateAppearance(card.state);
  const title = name ?? `Contract ${shortContract(card.nftContract)}`;
  const upcoming = card.state === 'scheduled' || card.state === 'armed';
  const final = upcoming && isFinalMinute(now, card.executeAt);
  const wallets = card.walletIds.length;

  const offerCancelAll = card.cancellable && sameDrop.length >= 2;
  const jobsToCancel = confirming === 'drop' ? sameDrop.flatMap((c) => c.jobs) : card.jobs;

  const cancel = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(jobsToCancel.map((j) => apiRequest(`/schedules/mints/${j.jobId}`, { method: 'DELETE' })));
      // A 404 means it is already gone, which is what was asked for.
      const failed = results.filter((r) => r.status === 'rejected' && !(r.reason instanceof ApiError && r.reason.status === 404));
      if (failed.length > 0) throw new Error(`Cancelled ${jobsToCancel.length - failed.length} of ${jobsToCancel.length}. Try again.`);
    },
    onSuccess: () => setConfirming(null),
    onSettled: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });

  return (
    <article className={`ops-card ops-card--${card.state}`} aria-label={`${title}, ${label}`}>
      <header className="ops-card__head">
        <span className="ops-card__icon">
          <ChainIcon chain={viewForChainId(card.chainId, chainName)} />
        </span>
        <div className="ops-card__title">
          <h3 title={`${title} (${card.nftContract})`}>{title}</h3>
          <div className="ops-card__meta">
            {card.phase === 'public' ? <UnlockedIcon aria-hidden /> : <LockedIcon aria-hidden />}
            <span>{card.phase === 'public' ? 'Public' : 'Allow-list'}</span>
            <span aria-hidden>·</span>
            <span>
              {wallets} wallet{wallets === 1 ? '' : 's'}
              {/* More jobs than wallets means a wallet is scheduled more than once, and each job mints. */}
              {card.jobs.length > wallets && `, ${card.jobs.length} mints`}
            </span>
          </div>
        </div>
        <span className={`pill ${cls}`}>{label}</span>
      </header>

      <div className="ops-card__body">
        {upcoming && (
          <>
            <div className={`ops-countdown${final ? ' is-final' : ''}`} role="timer" aria-label={`Mints in ${formatDuration(card.executeAt - now)}`}>
              {formatDuration(card.executeAt - now)}
            </div>
            <div className="ops-card__sub">until mint, {new Date(card.executeAt).toLocaleString()}</div>
          </>
        )}
        {card.state === 'minting' && (
          <>
            <div className="ops-card__status">Minting</div>
            <div className="ops-card__sub">{countsLine(card)}</div>
          </>
        )}
        {card.done && (
          <>
            <div className="ops-card__sub">{card.state === 'finished' ? 'Finished, outcome not recorded' : `Ran ${new Date(card.executeAt).toLocaleString()}`}</div>
            <div className="ops-card__status" style={{ fontSize: 13 }}>
              {countsLine(card)}
            </div>
          </>
        )}
      </div>

      {card.failure && (
        <Notice tone="error" compact>{card.failure}</Notice>
      )}

      {editing && card.cancellable && <EditPanel card={card} onDone={() => setEditing(false)} />}

      <footer className="ops-card__foot">
        <Link to={`/mint?collection=${card.nftContract}`}>Open in Mint</Link>
        {card.cancellable && !editing && (
          <span className="ops-card__actions">
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="danger" onClick={() => setConfirming('card')}>
              Cancel schedule
            </button>
          </span>
        )}
      </footer>
      {offerCancelAll && !editing && (
        <button type="button" className="ops-card__linkbtn" onClick={() => setConfirming('drop')}>
          Cancel all {sameDrop.length} schedules for this drop
        </button>
      )}

      {confirming && (
        <div className="modal-backdrop" onClick={() => !cancel.isPending && setConfirming(null)} onKeyDown={(e) => e.key === 'Escape' && !cancel.isPending && setConfirming(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`cancel-title-${card.id}`} onClick={(e) => e.stopPropagation()}>
            <h2 id={`cancel-title-${card.id}`} style={{ fontSize: 15, marginBottom: 8 }}>
              {confirming === 'drop' ? 'Cancel every schedule for this drop?' : 'Cancel this schedule?'}
            </h2>
            <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginBottom: 14, lineHeight: 1.6 }}>
              This permanently deletes {jobsToCancel.length} scheduled mint{jobsToCancel.length === 1 ? '' : 's'} for {title}
              {confirming === 'drop' ? ` (${sameDrop.length} schedules, every phase and time)` : ''}. Nothing will mint. It cannot be undone.
            </p>
            {cancel.isError && (
              <Notice tone="error">{cancel.error instanceof Error ? cancel.error.message : 'Could not cancel.'}</Notice>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" autoFocus onClick={() => setConfirming(null)} disabled={cancel.isPending}>
                Keep schedule
              </button>
              <button type="button" className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {cancel.isPending ? 'Cancelling…' : confirming === 'drop' ? 'Cancel all' : 'Cancel schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
