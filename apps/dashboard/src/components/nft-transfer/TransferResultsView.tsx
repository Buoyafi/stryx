import { chainById, explorerTxUrl } from '@stryx/chains';
import { shortError } from '../../lib/short-error';
import type { NftTransferResultRow } from '../../lib/nft-transfer';
import { NftThumb } from './NftThumb';

const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

const STATUS: Record<NftTransferResultRow['status'], { cls: 'live' | 'fail' | 'idle'; label: string }> = {
  sent: { cls: 'live', label: 'sent' },
  skipped: { cls: 'idle', label: 'skipped' },
  failed: { cls: 'fail', label: 'failed' },
  unknown: { cls: 'idle', label: 'unknown' },
};

/** Per-item pending/confirmed/failed after a transfer batch. */
export function TransferResultsView({ chainId, results, onClose }: { chainId: number; results: readonly NftTransferResultRow[]; onClose: () => void }) {
  const chain = chainById(chainId);
  const sentCount = results.filter((r) => r.status === 'sent').length;

  return (
    <div>
      <p style={{ fontSize: 12.5, marginBottom: 10 }}>
        {sentCount}/{results.length} item{results.length === 1 ? '' : 's'} sent.
      </p>
      <table className="dense" aria-label="Transfer results">
        <thead>
          <tr>
            <th></th>
            <th>Token</th>
            <th>Status</th>
            <th>Transaction</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const s = STATUS[r.status];
            const link = r.hash && chain ? explorerTxUrl(chain, r.hash) : undefined;
            return (
              <tr key={`${r.walletId}:${r.contract}:${r.tokenId}`}>
                <td>
                  <NftThumb tokenId={r.tokenId} size={28} />
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  #{r.tokenId}
                </td>
                <td>
                  <span className={`pill ${s.cls}`}>{s.label}</span>
                </td>
                <td className="mono">
                  {r.hash ? (
                    link ? (
                      <a href={link} target="_blank" rel="noreferrer noopener" title={r.hash}>
                        {shortHash(r.hash)}
                      </a>
                    ) : (
                      <span title={r.hash}>{shortHash(r.hash)}</span>
                    )
                  ) : (
                    '-'
                  )}
                </td>
                <td style={{ fontSize: 12 }} title={r.error}>
                  {r.error ? shortError(r.error, 50) : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
