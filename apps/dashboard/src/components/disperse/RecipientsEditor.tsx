import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';
import { balanceKeys, PICKER_BALANCE_STALE_MS } from '../../lib/balance-cache';
import { formatWei } from '../../lib/units';
import { parseAddressList, parseCsv, removeDuplicateRows, type AmountMode, type RecipientRow, type RecipientValidation } from '../../lib/recipients';
import { GlowHint } from '../GlowHint';
import type { OurWallet } from './SourcePicker';
import { Notice } from '../Notice';

let counter = 0;
const newId = () => `r${++counter}`;

const SOURCE_LABEL = { ours: 'Stryx wallet', pasted: 'pasted', csv: 'CSV' } as const;
const QUICK_AMOUNTS = ['0.001', '0.005', '0.01', '0.05'] as const;
const short = (v: string) => (v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v);

/**
 * Builds the recipient list three ways, and they combine: tick our own wallets (operator only), paste
 * addresses, paste CSV "address,amount".
 */
export function RecipientsEditor(props: {
  mode: 'operator' | 'user';
  rows: readonly RecipientRow[];
  setRows: (update: (rows: readonly RecipientRow[]) => readonly RecipientRow[]) => void;
  validation: RecipientValidation;
  amountMode: AmountMode;
  setAmountMode: (m: AmountMode) => void;
  sameAmount: string;
  setSameAmount: (v: string) => void;
  /** Your Stryx wallets that can be recipients (never the source). Ignored in user mode. */
  ourSelectable: readonly OurWallet[];
  symbol: string;
  /** Selected chain, to show each wallet's balance on it. */
  chainId?: number | null;
}) {
  const { mode, rows, setRows, validation, amountMode, symbol } = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const chainKey = props.chainId == null ? '' : String(props.chainId);
  // Same query (and cache) as the wallet picker above: no extra request once that list is loaded.
  const { data: balanceData } = useQuery({
    queryKey: balanceKeys.chain(chainKey),
    queryFn: () => apiRequest<{ balances: { walletId: string; wei: string; formatted: string; error?: string }[] }>(`/wallets/balances?chainId=${chainKey}`),
    enabled: mode === 'operator' && chainKey !== '',
    staleTime: PICKER_BALANCE_STALE_MS,
  });
  const balanceOf = (walletId: string) => {
    const b = balanceData?.balances?.find((x) => x.walletId === walletId);
    return b ? (b.error ? '-' : b.formatted) : null;
  };
  const [pasteText, setPasteText] = useState('');
  const [csvText, setCsvText] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const addPasted = () => {
    const found = parseAddressList(pasteText);
    if (found.length === 0) return;
    setRows((r) => [...r, ...found.map((f) => ({ id: newId(), source: 'pasted' as const, address: f.address, line: f.line, ...(amountMode === 'each' ? { amount: props.sameAmount } : {}) }))]);
    setPasteText('');
    setNote(`Added ${found.length} pasted address${found.length === 1 ? '' : 'es'}.`);
  };

  const addCsv = () => {
    const { rows: parsed, skippedHeader } = parseCsv(csvText);
    if (parsed.length === 0) return;
    setRows((r) => [...r, ...parsed.map((p) => ({ id: newId(), source: 'csv' as const, address: p.address, amount: p.amount, line: p.line, badColumns: p.badColumns }))]);
    setCsvText('');
    setNote(`Added ${parsed.length} CSV row${parsed.length === 1 ? '' : 's'}${skippedHeader ? ' (header skipped)' : ''}.`);
  };

  const toggleOurs = (w: OurWallet) =>
    setRows((r) => {
      const id = `ours:${w.id}`;
      return r.some((x) => x.id === id) ? r.filter((x) => x.id !== id) : [...r, { id, source: 'ours' as const, address: w.address, ...(w.label ? { label: w.label } : {}), ...(amountMode === 'each' ? { amount: props.sameAmount } : {}) }];
    });

  const chooseMode = (m: AmountMode) => {
    props.setAmountMode(m);
    // Moving to per-recipient amounts: give every row without one the shared amount to start from.
    if (m === 'each') setRows((r) => r.map((x) => (x.amount?.trim() ? x : { ...x, amount: props.sameAmount })));
  };

  const hasDuplicates = validation.recipients.some((v) => v.errors.some((e) => /Duplicate/.test(e)));

  return (
    <div>
      <div className="segmented segmented--quiet dsp-seg" role="radiogroup" aria-label="Amount">
        {(['same', 'each'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={amountMode === m}
            tabIndex={amountMode === m ? 0 : -1}
            className={`segmented__option${amountMode === m ? ' is-selected' : ''}`}
            title={m === 'same' ? 'The same amount to every recipient' : 'A different amount for each recipient'}
            onClick={() => chooseMode(m)}
          >
            {m === 'same' ? 'Flat' : 'Variable'}
          </button>
        ))}
      </div>
      {amountMode === 'same' && (
        <div className="dsp-amount">
          <span className="dsp-label">Amount each</span>
          <label className="dsp-amount__field">
            <span className="sr-only">Amount each</span>
            <input className="mono" inputMode="decimal" value={props.sameAmount} onChange={(e) => props.setSameAmount(e.target.value)} aria-label="Amount each" />
            <em>{symbol}</em>
          </label>
          <div className="dsp-quick" role="group" aria-label="Quick amounts">
            {QUICK_AMOUNTS.map((v) => (
              <button key={v} type="button" className="dsp-quick__btn mono" onClick={() => props.setSameAmount(v)}>
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'operator' && (
        <div className="dsp-wallets">
          <div className="dsp-wallets__head">
            <span className="dsp-label">Stryx wallets</span>
            {props.ourSelectable.length > 1 && (
              <button
                type="button"
                className="dsp-link"
                onClick={() => {
                  const ids = props.ourSelectable.map((w) => `ours:${w.id}`);
                  const all = ids.every((id) => rows.some((r) => r.id === id));
                  if (all) return setRows((r) => r.filter((x) => !ids.includes(x.id)));
                  setRows((r) => [...r, ...props.ourSelectable.filter((w) => !r.some((x) => x.id === `ours:${w.id}`)).map((w) => ({ id: `ours:${w.id}`, source: 'ours' as const, address: w.address, ...(w.label ? { label: w.label } : {}), ...(amountMode === 'each' ? { amount: props.sameAmount } : {}) }))]);
                }}
              >
                {props.ourSelectable.every((w) => rows.some((r) => r.id === `ours:${w.id}`)) ? 'Clear selection' : 'Select all'}
              </button>
            )}
          </div>
          {props.ourSelectable.length === 0 ? (
            <span style={{ color: 'var(--stryx-sub)', fontSize: 12.5 }}>No other wallets to choose from.</span>
          ) : (
            <div className="dsp-tiles">
              {props.ourSelectable.map((w) => {
                const picked = rows.some((r) => r.id === `ours:${w.id}`);
                const bal = balanceOf(w.id);
                return (
                  <label key={w.id} className={`dsp-tile${picked ? ' is-picked' : ''}`}>
                    <input type="checkbox" checked={picked} onChange={() => toggleOurs(w)} />
                    <span className="dsp-tile__tick" aria-hidden="true">✓</span>
                    <span className="dsp-tile__text">
                      <b>{w.label ?? 'unnamed'}</b>
                      <small className="mono">
                        {short(w.address)}
                        {bal !== null && ` · ${bal}`}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="dsp-paste">
        <div>
          <label htmlFor="paste-addresses" className="dsp-label">
            Paste addresses (one per line)
          </label>
          <textarea id="paste-addresses" className="mono" rows={4} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="0x…" style={{ marginTop: 4 }} />
          <button type="button" onClick={addPasted} disabled={!pasteText.trim()} style={{ marginTop: 6, fontSize: 12 }}>
            Add addresses
          </button>
        </div>
        <div>
          <label htmlFor="paste-csv" className="dsp-label">
            Paste CSV: address,amount
          </label>
          <textarea id="paste-csv" className="mono" rows={4} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="0x…,0.01" style={{ marginTop: 4 }} />
          <div className="dsp-paste__btns">
            <button type="button" onClick={addCsv} disabled={!csvText.trim()} style={{ marginTop: 6, fontSize: 12 }}>
              Add CSV
            </button>
            <button type="button" onClick={() => fileInput.current?.click()} style={{ marginTop: 6, fontSize: 12 }}>
              Choose a file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="sr-only"
              tabIndex={-1}
              aria-label="CSV file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void file.text().then(setCsvText);
              }}
            />
          </div>
        </div>
      </div>
      {note && (
        <p role="status" style={{ color: 'var(--stryx-sub)', fontSize: 12, marginBottom: 10 }}>
          {note}
        </p>
      )}

      <GlowHint
        visible={rows.length === 0}
        text="Add at least one recipient to continue"
        onActivate={() => document.getElementById('paste-addresses')?.focus()}
      />
      {validation.problems
        .filter((p) => p !== 'Add at least one recipient.')
        .map((p) => (
          <Notice key={p} tone="error">
            {p}
          </Notice>
        ))}

      {rows.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0' }}>
            <span style={{ fontSize: 12.5 }}>
              {rows.length} recipient{rows.length === 1 ? '' : 's'}
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              {hasDuplicates && (
                <button type="button" onClick={() => setRows((r) => removeDuplicateRows(r))} style={{ fontSize: 12 }}>
                  Remove duplicates
                </button>
              )}
              <button type="button" onClick={() => setRows(() => [])} style={{ fontSize: 12 }}>
                Clear all
              </button>
            </span>
          </div>
          <div className="dsp-scroll">
          <table className="dense dsp-table" aria-label="Recipients">
            <thead>
              <tr>
                <th>#</th>
                <th>Address</th>
                <th>From</th>
                <th>Amount</th>
                <th>Check</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {validation.recipients.map((v) => (
                <tr key={v.row.id} className={v.errors.length > 0 ? 'row-bad' : undefined}>
                  <td className="mono dsp-t-num">{v.position}</td>
                  <td className="mono dsp-t-addr" title={v.row.address}>
                    {v.address ?? short(v.row.address)}
                    {v.row.label && <div style={{ color: 'var(--stryx-sub)', fontSize: 11 }}>{v.row.label}</div>}
                  </td>
                  <td className="dsp-t-from" style={{ fontSize: 12 }}>{SOURCE_LABEL[v.row.source]}</td>
                  <td className="dsp-t-amount">
                    {amountMode === 'each' ? (
                      <input className="mono" style={{ width: 130 }} inputMode="decimal" aria-label={`Amount for recipient ${v.position}`} value={v.row.amount ?? ''} onChange={(e) => setRows((r) => r.map((x) => (x.id === v.row.id ? { ...x, amount: e.target.value } : x)))} />
                    ) : (
                      <span className="mono">{v.wei !== undefined ? formatWei(v.wei) : '-'}</span>
                    )}
                  </td>
                  <td className="dsp-t-check" style={{ fontSize: 12 }}>
                    {v.errors.map((e) => (
                      <div key={e} className="tag tag--error">
                        {e}
                      </div>
                    ))}
                    {v.errors.length === 0 && (
                      <span className="tag tag--ok">{v.checksum === 'verified' ? 'checksum ok' : 'valid'}</span>
                    )}
                    {v.warnings.map((w) => (
                      <div key={w} className="tag tag--warn">
                        {w}
                      </div>
                    ))}
                  </td>
                  <td className="dsp-t-remove">
                    <button type="button" aria-label={`Remove recipient ${v.position}`} onClick={() => setRows((r) => r.filter((x) => x.id !== v.row.id))} style={{ fontSize: 12, padding: '2px 8px' }}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}
