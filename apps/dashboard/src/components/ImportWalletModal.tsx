import { useState } from 'react';
import { toast } from '@stryx/toast-ui';
import { apiRequest, ApiError } from '../lib/api';
import { CopyableValue } from './CopyableValue';
import { shortError } from '../lib/short-error';
import { countKeyLines, parseImportKeys, type ImportEntry } from '../lib/import-keys';
import { Notice } from './Notice';
import { useEscapeToClose } from '../lib/useEscapeToClose';

interface ImportedWallet {
  id: string;
  address: string;
}

type ResultRow =
  | { line: number; status: 'imported'; address: string }
  | { line: number; status: 'exists' | 'failed'; message: string };

/**
 * Imports one or many private keys as custodial wallets, one POST /wallets/import per key, so one bad
 * key never fails the rest.
 */
export function ImportWalletModal({ onCancel, onImported }: { onCancel: () => void; onImported: () => void }) {
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [reveal, setReveal] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ResultRow[] | null>(null);

  const lines = countKeyLines(text);
  const submitting = progress !== null && results === null;

  async function importOne(entry: ImportEntry): Promise<ResultRow> {
    try {
      const wallet = await apiRequest<ImportedWallet>('/wallets/import', {
        method: 'POST',
        body: { privateKey: entry.key, ...(entry.label ? { label: entry.label } : {}) },
      });
      return { line: entry.line, status: 'imported', address: wallet.address };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return { line: entry.line, status: 'exists', message: 'Already imported.' };
      if (err instanceof ApiError) {
        const body = err.body as { message?: string; error?: string } | null;
        return { line: entry.line, status: 'failed', message: body?.message ?? body?.error ?? `Import failed (HTTP ${err.status}).` };
      }
      return { line: entry.line, status: 'failed', message: 'Could not reach the API.' };
    }
  }

  async function submit() {
    const parsed = parseImportKeys(text, label);
    if (!parsed.ok) {
      // Nothing was sent: the operator fixes the named lines and tries again.
      setProblems(parsed.problems);
      return;
    }
    setProblems([]);
    setText(''); // the keys now live only in `queue`, and each is dropped once sent
    const queue: ImportEntry[] = parsed.entries;
    const rows: ResultRow[] = [];
    setProgress({ done: 0, total: queue.length });
    // One at a time: a key is a secret, and a burst of parallel requests buys nothing here.
    while (queue.length > 0) {
      const entry = queue.shift()!;
      rows.push(await importOne(entry));
      setProgress({ done: rows.length, total: parsed.entries.length });
    }
    setResults(rows);

    const imported = rows.filter((r) => r.status === 'imported').length;
    const failed = rows.length - imported;
    if (imported > 0) onImported();
    if (rows.length === 1) {
      const only = rows[0]!;
      if (only.status === 'imported') toast.success('Wallet imported');
      else toast.error('Could not import wallet', shortError(only.message));
    } else if (failed === 0) {
      toast.success(`${imported} wallets imported`);
    } else {
      toast.error(`${imported} of ${rows.length} wallets imported`, `${failed} not imported: see the list.`);
    }
  }

  const single = results?.length === 1 ? results[0]! : null;

  useEscapeToClose(submitting ? undefined : onCancel);

  return (
    <div className="modal-backdrop" onClick={submitting ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {single?.status === 'imported' ? (
          <>
            <h2 className="msg-live" style={{ fontSize: 15, marginBottom: 8 }}>Wallet imported</h2>
            <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginBottom: 12, lineHeight: 1.6 }}>
              Confirm this is the address you meant to import:
            </p>
            <div className="mono import-address">
              <CopyableValue value={single.address} display={single.address} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary" onClick={onCancel}>
                Done
              </button>
            </div>
          </>
        ) : results ? (
          <>
            <h2 style={{ fontSize: 15, marginBottom: 8 }}>{summaryTitle(results)}</h2>
            <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginBottom: 12, lineHeight: 1.6 }}>
              Confirm these are the addresses you meant to import. Lines refer to what you pasted.
            </p>
            <div className="stryx-scroll" style={{ maxHeight: 320, overflowY: 'auto', marginBottom: 16 }}>
              <table className="dense" aria-label="Import results">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.line}>
                      <td className="mono">{r.line}</td>
                      <td>
                        {r.status === 'imported' ? (
                          <CopyableValue value={r.address} display={r.address} />
                        ) : (
                          <span className={r.status === 'exists' ? 'tag' : 'tag tag--error'} title={r.message}>
                            {shortError(r.message)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary" onClick={onCancel}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: 15, marginBottom: 8 }}>Import wallets</h2>
            <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginBottom: 14, lineHeight: 1.6 }}>
              Imports existing private keys. Each is encrypted and custodied exactly the same way a
              generated wallet's key is from this point on: Stryx holds it, same as any other wallet here.
            </p>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <label htmlFor="import-keys" style={{ fontSize: 12, color: 'var(--stryx-sub)' }}>
                Private keys, one per line
              </label>
              <label style={{ fontSize: 12, color: 'var(--stryx-sub)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} style={{ width: 'auto' }} />
                Show
              </label>
            </div>
            <textarea
              id="import-keys"
              className={`mono import-keys${reveal ? '' : ' import-keys--masked'}`}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              rows={Math.min(8, Math.max(3, lines + 1))}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (problems.length > 0) setProblems([]);
              }}
              placeholder={'64 hex characters each, with or without 0x\nOptional label after a comma: 0xabc…, Main'}
              disabled={submitting}
              autoFocus
            />
            {problems.length > 0 && (
              <Notice tone="error" compact className="notice--spaced" detail={problems.slice(0, 12).join('\n')}>
                {problems.length === 1 ? problems[0]! : `${problems.length} lines need fixing.`}
              </Notice>
            )}

            <div style={{ fontSize: 12, color: 'var(--stryx-sub)', margin: '14px 0 4px' }}>Label (optional)</div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Treasury (imported)" disabled={submitting} />
            {lines > 1 && (
              <div style={{ fontSize: 11, color: 'var(--stryx-sub)', marginTop: 4 }}>
                Numbered for several keys ("{label.trim() || 'Label'} 1", "{label.trim() || 'Label'} 2"); a label after a comma on a line wins.
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end', alignItems: 'center' }}>
              {submitting && progress && (
                <span style={{ fontSize: 12, color: 'var(--stryx-sub)', marginRight: 'auto' }}>
                  Importing {progress.done + 1 > progress.total ? progress.total : progress.done + 1} of {progress.total}…
                </span>
              )}
              <button onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
              <button className="primary" onClick={() => void submit()} disabled={lines === 0 || submitting}>
                {submitting ? 'Importing…' : lines > 1 ? `Import ${lines} wallets` : 'Import'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function summaryTitle(rows: readonly ResultRow[]): string {
  const imported = rows.filter((r) => r.status === 'imported').length;
  const exists = rows.filter((r) => r.status === 'exists').length;
  const failed = rows.length - imported - exists;
  const parts = [`${imported} imported`, exists > 0 ? `${exists} already there` : '', failed > 0 ? `${failed} failed` : ''].filter(Boolean);
  return parts.join(', ');
}
