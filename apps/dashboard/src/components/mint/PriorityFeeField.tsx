import { useState } from 'react';
import { chainById } from '@stryx/chains';
import { priorityFeeProblem, tipCostHint, tipSettingShown } from '../../lib/priority-fee';
import { fetchTipSuggestion, phaseLine, showGwei, tipChoices, type PastPhase, type TipSuggestion } from '../../lib/tip-suggestion';
import { Notice } from '../Notice';

/** What the Suggest button looks back at: this drop's contract and its phases that have already opened. */
export interface TipContext {
  contract: string;
  pastPhases: readonly PastPhase[];
}

type SuggestState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: TipSuggestion };

/** The priority fee (tip) input, in gwei. */
export function PriorityFeeField({ chainId, symbol, value, onChange, tipContext }: { chainId: number; symbol: string; value: string; onChange: (v: string) => void; tipContext?: TipContext }) {
  const [suggest, setSuggest] = useState<SuggestState>({ kind: 'idle' });
  if (!tipSettingShown(chainId)) return null;
  const floor = chainById(chainId)?.feeMarket.minPriorityFeeGwei ?? null;
  const problem = priorityFeeProblem(chainId, value);
  const hint = tipCostHint(value, symbol);
  const past = tipContext?.pastPhases ?? [];

  const ask = () => {
    setSuggest({ kind: 'loading' });
    fetchTipSuggestion(chainId, tipContext?.contract ?? null, past).then(
      (data) => setSuggest({ kind: 'ready', data }),
      () => setSuggest({ kind: 'error' }),
    );
  };

  return (
    <div style={{ fontSize: 12.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Priority fee (gwei, optional)
          <input
            type="text"
            inputMode="decimal"
            aria-label="Priority fee in gwei"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={floor !== null ? `network (min ${floor})` : 'network'}
            style={{ width: 120 }}
          />
        </label>
        <button type="button" className="tip-suggest__ask" onClick={ask} disabled={suggest.kind === 'loading'}>
          {suggest.kind === 'loading' ? 'Reading…' : suggest.kind === 'ready' ? 'Refresh' : 'Suggest'}
        </button>
      </div>
      {problem ? (
        <Notice tone="error" compact className="notice--spaced">{problem}</Notice>
      ) : (
        <div style={{ fontSize: 11, marginTop: 3, color: 'var(--stryx-sub)' }}>{`A higher tip gets in earlier on a busy mint. Blank uses the network's suggestion${hint ? `; this ${hint}` : ''}.`}</div>
      )}
      {suggest.kind === 'error' && (
        <Notice tone="error" compact className="notice--spaced">
          Couldn't read recent tips from the chain. Try again in a moment.
        </Notice>
      )}
      {suggest.kind === 'ready' && <SuggestionPanel data={suggest.data} chainId={chainId} past={past} value={value} onPick={onChange} hasContract={!!tipContext} />}
    </div>
  );
}

function SuggestionPanel({ data, chainId, past, value, onPick, hasContract }: { data: TipSuggestion; chainId: number; past: readonly PastPhase[]; value: string; onPick: (v: string) => void; hasContract: boolean }) {
  const choices = tipChoices(data, chainId, past);
  const net = data.network;
  return (
    <div className="tip-suggest" role="region" aria-label="Priority fee suggestions">
      {choices.length > 0 ? (
        <div className="tip-suggest__choices">
          {choices.map((c) => (
            <button key={c.key} type="button" className={`tip-suggest__choice${value.trim() === c.gwei ? ' is-picked' : ''}`} onClick={() => onPick(c.gwei)} title={c.why} aria-pressed={value.trim() === c.gwei}>
              <span>{c.label}</span>
              <b className="mono">{c.gwei} gwei</b>
            </button>
          ))}
        </div>
      ) : (
        <p className="tip-suggest__line">Nothing to suggest: the readings below are all zero. Blank is fine.</p>
      )}
      <ul className="tip-suggest__readings">
        {choices.map((c) => (
          <li key={c.key}>
            <b>{c.label}:</b> {c.why}
          </li>
        ))}
        {net && (
          <li>
            Right now: typical {showGwei(net.typicalWei)}, busy {showGwei(net.busyWei)}, top 1% {showGwei(net.topWei)} gwei
            {net.nextBaseFeeWei ? ` (base fee ${showGwei(net.nextBaseFeeWei)} gwei, paid on top of the tip)` : ''}.
          </li>
        )}
        {data.phases.map((p) => (
          <li key={p.startMs}>{phaseLine(p, past)}</li>
        ))}
        {hasContract && past.length === 0 && <li>No earlier phase of this drop has opened yet, so there is nothing of its own to compare with.</li>}
      </ul>
      <p className="tip-suggest__line">These are estimates from what is already on chain. Nobody can see what others will tip for the next phase.</p>
    </div>
  );
}
