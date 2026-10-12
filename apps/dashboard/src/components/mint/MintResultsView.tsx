import { chainById, explorerTxUrl } from '@stryx/chains';
import { shortError } from '../../lib/short-error';
import type { MintFireRow } from '../../lib/mint-fire';

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

const STATUS: Record<MintFireRow['status'], { cls: 'live' | 'pending' | 'fail' | 'idle'; label: string }> = {
  sent: { cls: 'live', label: 'sent' },
  scheduled: { cls: 'pending', label: 'scheduled' },
  failed: { cls: 'fail', label: 'failed' },
  skipped: { cls: 'idle', label: 'skipped' },
  unknown: { cls: 'pending', label: 'unknown' },
};

/** One row per wallet: what was attempted, its outcome, and a link to the transaction when one exists. */
export function MintResultsView({ rows, chainId, onClose }: { rows: readonly MintFireRow[]; chainId: number; onClose: () => void }) {
  const chain = chainById(chainId);
  const sentCount = rows.filter((r) => r.status === 'sent' || r.status === 'scheduled').length;

  return (
    <div>
      <p style={{ fontSize: 12.5, marginBottom: 10 }}>
        {sentCount}/{rows.length} wallet{rows.length === 1 ? '' : 's'} succeeded.
      </p>
      <table className="dense" aria-label="Mint results">
        <thead>
          <tr>
            <th>Wallet</th>
            <th>Quantity</th>
            <th>Status</th>
            <th>Transaction</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = STATUS[r.status];
            const link = r.hash && chain ? explorerTxUrl(chain, r.hash) : undefined;
            return (
              <tr key={r.walletId}>
                <td className="mono" title={r.address}>
                  {shortAddress(r.address)}
                </td>
                <td className="mono">{r.quantity}</td>
                <td>
                  <span className={`pill ${s.cls}`}>{s.label}</span>
                </td>
                <td className="mono">
                  {r.hash ? (
                    link ? (
                      <a href={link} target="_blank" rel="noreferrer noopener" title={r.hash}>
                        {shortHash(r.hash)}
                        <span aria-hidden="true"> ↗</span>
                        <span className="sr-only"> (opens the block explorer)</span>
                      </a>
                    ) : (
                      <span title={r.hash}>{shortHash(r.hash)}</span>
                    )
                  ) : (
                    <span style={{ color: 'var(--stryx-sub)' }}>-</span>
                  )}
                </td>
                <td style={{ color: 'var(--stryx-sub)', fontSize: 12 }} title={r.detail}>
                  {shortError(r.detail, 60)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" style={{ marginTop: 14 }} onClick={onClose}>
        Done
      </button>
    </div>
  );
}
