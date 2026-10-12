import { useState } from 'react';
import { priorityFeeBody, priorityFeeProblem } from '../../lib/priority-fee';
import { PriorityFeeField, type TipContext } from './PriorityFeeField';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { weiToEther } from '../../lib/wei-format';
import { parseAmount, amountProblemText } from '../../lib/units';
import { countdownStatus } from '../../lib/countdown';
import type { Phase } from '../../lib/collection-phases';
import type { WalletEligibilityRow } from '../../lib/mint-eligibility';
import { getSignedMintStatus, scheduleSignedMint, type SignedMintScheduleInput } from '../../lib/signed-mint';
import { QuantityStepper } from '../QuantityStepper';
import { Switch } from './Switch';
import { Notice } from '../Notice';
import { DateTimePicker } from '../DateTimePicker';

interface WalletLite {
  id: string;
  address: string;
  label: string | null;
}

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function eligibilityHint(row: WalletEligibilityRow | undefined): string | null {
  if (!row) return null;
  if (row.eligible === 'eligible') return 'Eligible';
  if (row.eligible === 'not_eligible') return row.reason === 'not_on_allowlist' ? 'Not on list' : 'Not eligible';
  return null;
}

/**
 * Scheduling for a signed stage. Separate from the public and Merkle flow because a signed mint is not
 * built until the stage opens: OpenSea issues the calldata then. Wallets are picked by hand; when an
 * eligibility check has run, its answer shows beside each wallet as a hint.
 */
export function SignedMintPanel({
  phase,
  chainId,
  contract,
  slug,
  wallets,
  symbol,
  eligibility,
  tipContext,
}: {
  phase: Phase;
  chainId: number;
  contract: string;
  slug: string | null;
  wallets: readonly WalletLite[];
  symbol: string;
  eligibility: ReadonlyMap<string, WalletEligibilityRow>;
  /** What the tip field's Suggest button looks back at. */
  tipContext?: TipContext;
}) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['signed-mint-status'], queryFn: getSignedMintStatus, staleTime: 60_000 });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [dryRun, setDryRun] = useState(false);
  const [simulate, setSimulate] = useState(true);
  const [maxSpend, setMaxSpend] = useState('');
  const [priorityFeeGwei, setPriorityFeeGwei] = useState('');
  const [rehearsalAt, setRehearsalAt] = useState('');
  const [step, setStep] = useState<'form' | 'review'>('form');

  const maxPerWallet = phase.maxPerWallet ?? 50;
  const stagePhase = countdownStatus(Date.now(), phase.startMs, phase.endMs)?.phase;
  const started = stagePhase !== 'before';
  const ended = stagePhase === 'ended';
  const rehearsalMs = dryRun && rehearsalAt ? new Date(rehearsalAt).getTime() : null;
  // A live stage fires now (real or dry run) unless a dry run picks its own rehearsal time.
  const fireNow = started && !ended && rehearsalMs === null;
  const chosen = wallets.filter((w) => selected.has(w.id)).map((w) => ({ wallet: w, quantity: Math.min(quantities[w.id] ?? 1, maxPerWallet) }));
  const totalQuantity = chosen.reduce((n, c) => n + c.quantity, 0);
  const totalWei = phase.priceWei !== null ? BigInt(phase.priceWei) * BigInt(totalQuantity) : null;
  const spendParsed = maxSpend.trim() === '' ? null : parseAmount(maxSpend);

  // Anything here means nothing can be scheduled at all.
  const blocker = !status.data
    ? status.isError
      ? 'Could not read whether signed minting is enabled on the server.'
      : 'Checking whether signed minting is enabled…'
    : !status.data.executionEnabled
      ? 'Signed minting is switched off on the server (SIGNED_MINT_EXECUTION_ENABLED). Nothing can be scheduled.'
      : !slug
        ? 'This collection has no OpenSea slug, which a signed stage needs.'
        : !phase.openSeaStageUuid
          ? 'OpenSea gives no id for this stage, so it cannot be scheduled.'
          : phase.priceWei === null
            ? 'OpenSea gives no price for this stage, so there is no price to hold the signed mint to.'
            : null;
  const formProblem =
    chosen.length === 0
      ? 'Select at least one wallet.'
      : spendParsed && !spendParsed.ok
        ? amountProblemText(spendParsed.problem)
        : priorityFeeProblem(chainId, priorityFeeGwei) !== null
          ? priorityFeeProblem(chainId, priorityFeeGwei)
        : ended && rehearsalMs === null
          ? 'The stage has ended: only a dry-run rehearsal at a picked time is possible.'
          : dryRun && rehearsalAt && (Number.isNaN(rehearsalMs) || (rehearsalMs ?? 0) < Date.now() + 15_000)
            ? 'Pick a rehearsal time at least 15 seconds from now.'
            : null;

  const schedule = useMutation({
    mutationFn: () => {
      const input: SignedMintScheduleInput = {
        chainId,
        nftContract: contract,
        slug: slug!,
        stageUuid: phase.openSeaStageUuid!,
        wallets: chosen.map((c) => ({ walletId: c.wallet.id, quantity: c.quantity })),
        maxPriceWei: phase.priceWei!,
        simulate,
        dryRun,
        maxSpendWei: spendParsed && spendParsed.ok ? spendParsed.wei.toString() : null,
        ...priorityFeeBody(priorityFeeGwei),
        ...(rehearsalMs !== null ? { rehearsalStartAt: rehearsalMs } : {}),
        ...(fireNow ? { fireNow: true } : {}),
      };
      return scheduleSignedMint(input);
    },
    onSuccess: () => {
      setSelected(new Set());
      setStep('form');
      void qc.invalidateQueries({ queryKey: ['signed-mints'] });
    },
  });

  const errorText = schedule.error instanceof ApiError ? ((schedule.error.body as { message?: string; reason?: string } | null)?.message ?? schedule.error.message) : schedule.error?.message;

  if (blocker) {
    return <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginTop: 12 }}>{blocker}</p>;
  }

  if (ended && !dryRun) {
    return (
      <div style={{ marginTop: 12, fontSize: 12.5 }}>
        <p style={{ color: 'var(--stryx-sub)', marginBottom: 8 }}>This stage has ended. A dry-run rehearsal at a time you pick still works.</p>
        <Switch checked={dryRun} onChange={() => setDryRun(true)} label="Dry run" />
      </div>
    );
  }

  if (schedule.isSuccess) {
    return (
      <div style={{ marginTop: 12, fontSize: 12.5 }}>
        <Notice tone="ok">
          {schedule.data.immediate
            ? `Firing now: ${schedule.data.stageLabel}. Warm-up has started; results appear on Activity within seconds.`
            : `Scheduled${schedule.data.rehearsal ? ' (dry-run rehearsal)' : ''}: ${schedule.data.stageLabel} at ${new Date(schedule.data.startAt).toLocaleString()}.`}
        </Notice>
        <p style={{ color: 'var(--stryx-sub)' }}>
          It counts down on <Link to="/activity">Activity</Link>, where it can be cancelled and where each wallet's result and timings appear.
        </p>
        <button type="button" style={{ marginTop: 8 }} onClick={() => schedule.reset()}>
          Schedule another
        </button>
      </div>
    );
  }

  if (step === 'review') {
    const fireAt = rehearsalMs ?? phase.startMs ?? 0;
    return (
      <div style={{ marginTop: 12 }}>
        <dl className="review-facts" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 18px', margin: '12px 0' }}>
          <dt style={{ color: 'var(--stryx-sub)' }}>Stage</dt>
          <dd>{phase.name} (signed)</dd>
          <dt style={{ color: 'var(--stryx-sub)' }}>Fires</dt>
          <dd>
            {fireNow ? 'Now: the stage is live' : new Date(fireAt).toLocaleString()}
            {fireNow ? '' : rehearsalMs !== null ? ' (rehearsal time you picked)' : ' (stage start from OpenSea, re-checked every 30s)'}
          </dd>
          <dt style={{ color: 'var(--stryx-sub)' }}>How</dt>
          <dd>
            {fireNow
              ? 'A quick warm-up, then each wallet asks OpenSea for its signed mint and sends the moment it arrives.'
              : 'Warm-up 5s before; from 1.5s before, each wallet asks OpenSea for its signed mint and sends the moment it arrives.'}
          </dd>
          <dt style={{ color: 'var(--stryx-sub)' }}>Price cap</dt>
          <dd className="mono">
            {weiToEther(phase.priceWei!)} {symbol} per NFT; a higher signed price is refused
          </dd>
          <dt style={{ color: 'var(--stryx-sub)' }}>Total</dt>
          <dd className="mono" style={{ fontWeight: 700 }}>
            {totalQuantity} NFT{totalQuantity === 1 ? '' : 's'} · {totalWei !== null ? `${weiToEther(totalWei.toString())} ${symbol}` : '-'} + gas
          </dd>
          <dt style={{ color: 'var(--stryx-sub)' }}>Mode</dt>
          <dd>
            {dryRun ? 'Dry run: everything up to simulation, nothing is sent' : 'Real mint'} · simulation {simulate ? 'on' : 'off'}
            {spendParsed?.ok ? ` · job spend limit ${maxSpend.trim()} ${symbol}` : ''}
            {priorityFeeGwei.trim() !== '' ? ` · priority fee ${priorityFeeGwei.trim()} gwei` : ''}
          </dd>
        </dl>
        <table className="dense" aria-label="Wallets to schedule">
          <thead>
            <tr>
              <th>Wallet</th>
              <th>Quantity</th>
            </tr>
          </thead>
          <tbody>
            {chosen.map((c) => (
              <tr key={c.wallet.id}>
                <td className="mono" title={c.wallet.address}>
                  {c.wallet.label ?? shortAddress(c.wallet.address)}
                </td>
                <td className="mono">{c.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {schedule.isError && (
          <Notice tone="error">{errorText ?? 'Could not schedule.'}</Notice>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
          <button type="button" onClick={() => setStep('form')} disabled={schedule.isPending}>
            Back
          </button>
          <button type="button" className="primary" onClick={() => schedule.mutate()} disabled={schedule.isPending}>
            {schedule.isPending ? 'Working…' : fireNow ? (dryRun ? 'Confirm dry run now' : 'Confirm and mint now') : dryRun ? 'Confirm dry run' : 'Confirm and schedule'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      {wallets.map((w) => {
        const hint = eligibilityHint(eligibility.get(w.id));
        const isOn = selected.has(w.id);
        return (
          <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--dash-line)' }}>
            <input
              type="checkbox"
              aria-label={`Select ${w.label ?? w.address}`}
              checked={isOn}
              onChange={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(w.id)) next.delete(w.id);
                  else next.add(w.id);
                  return next;
                })
              }
            />
            <span className="mono" style={{ flex: 1, fontSize: 12.5 }} title={w.address}>
              {w.label ?? shortAddress(w.address)}
            </span>
            {hint && <span style={{ fontSize: 12, color: hint === 'Eligible' ? 'var(--dash-live-text)' : 'var(--stryx-sub)' }}>{hint}</span>}
            <QuantityStepper
              value={Math.min(quantities[w.id] ?? 1, maxPerWallet)}
              onChange={(n) => setQuantities((prev) => ({ ...prev, [w.id]: n }))}
              isMax={false}
              onToggleMax={() => undefined}
              max={maxPerWallet}
              disableMax
            />
          </div>
        );
      })}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12, fontSize: 12.5 }}>
        <Switch checked={dryRun} onChange={() => setDryRun((v) => !v)} label="Dry run" />
        <Switch checked={simulate} onChange={() => setSimulate((v) => !v)} label="Simulate before sending" />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 10, fontSize: 12.5 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Job spend limit ({symbol}, optional)
          <input type="text" inputMode="decimal" value={maxSpend} onChange={(e) => setMaxSpend(e.target.value)} placeholder="none" style={{ width: 110 }} />
        </label>
        <PriorityFeeField chainId={chainId} symbol={symbol} value={priorityFeeGwei} onChange={setPriorityFeeGwei} {...(tipContext ? { tipContext } : {})} />
        {dryRun && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Rehearse at (optional)
            <DateTimePicker aria-label="Rehearse at" value={rehearsalAt} onChange={setRehearsalAt} min={() => Date.now()} />
          </label>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--dash-line-strong)' }}>
        <div style={{ fontSize: 12.5 }}>
          <div style={{ fontWeight: 600 }}>
            {totalQuantity} NFTs · {chosen.length} wallets
          </div>
          <div style={{ color: 'var(--stryx-sub)' }}>{totalWei !== null ? `${weiToEther(totalWei.toString())} ${symbol}` : '-'} + gas</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <button type="button" className="primary" disabled={formProblem !== null} title={formProblem ?? undefined} onClick={() => setStep('review')}>
            {fireNow ? (dryRun ? 'Dry run now' : 'Mint now') : dryRun ? 'Schedule dry run' : 'Schedule'}
          </button>
          {formProblem && <div style={{ fontSize: 11, color: 'var(--stryx-sub)', marginTop: 4 }}>{formProblem}</div>}
        </div>
      </div>
    </div>
  );
}
