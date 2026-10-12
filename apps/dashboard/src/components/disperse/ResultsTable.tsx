import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';
import { chainById, explorerTxUrl } from '@stryx/chains';
import { formatWei } from '../../lib/units';
import type { ItemStatus, SendItem } from '../../lib/disperse-send';

const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;

/** The agreed tokens and glyphs. Every state has a label, so none depends on colour alone. */
const STATUS: Record<ItemStatus, { cls: 'live' | 'pending' | 'fail' | 'idle'; label: string; hint?: string }> = {
  waiting: { cls: 'idle', label: 'waiting' },
  signing: { cls: 'pending', label: 'signing' },
  pending: { cls: 'pending', label: 'pending' },
  confirmed: { cls: 'live', label: 'confirmed' },
  failed: { cls: 'fail', label: 'failed' },
  unconfirmed: { cls: 'idle', label: 'unconfirmed', hint: 'Sent, but not confirmed yet. It may still land: check the explorer before sending again.' },
  not_sent: { cls: 'idle', label: 'not sent', hint: 'Nothing was sent for this recipient.' },
};

export function statusCounts(items: readonly SendItem[]): Record<ItemStatus, number> {
  const counts = { waiting: 0, signing: 0, pending: 0, confirmed: 0, failed: 0, unconfirmed: 0, not_sent: 0 } as Record<ItemStatus, number>;
  for (const i of items) counts[i.status]++;
  return counts;
}

/** One row per recipient: what was sent, its state, and a link to the transaction. */
export function ResultsTable({ items, chainId, symbol }: { items: readonly SendItem[]; chainId: number; symbol: string }) {
  const chain = chainById(chainId);
  return (
    <table className="dense" aria-label="Disperse results">
      <thead>
        <tr>
          <th>Recipient</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Transaction</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const s = STATUS[item.status];
          const link = item.hash && chain ? explorerTxUrl(chain, item.hash) : undefined;
          return (
            <tr key={item.address}>
              <td className="mono" title={item.address}>
                {short(item.address)}
              </td>
              <td className="mono">
                {formatWei(item.wei)} {symbol}
              </td>
              <td>
                <span className={`pill ${s.cls}`} title={s.hint}>
                  {s.label}
                </span>
              </td>
              <td className="mono">
                {item.hash ? (
                  link ? (
                    <a href={link} target="_blank" rel="noreferrer noopener" title={item.hash}>
                      {short(item.hash)}
                      <span aria-hidden="true"> ↗</span>
                      <span className="sr-only"> (opens the block explorer)</span>
                    </a>
                  ) : (
                    <span title={item.hash}>{short(item.hash)}</span>
                  )
                ) : (
                  <span style={{ color: 'var(--stryx-sub)' }}>-</span>
                )}
              </td>
              <td style={{ color: 'var(--stryx-sub)', fontSize: 12 }} title={item.error}>
                {item.error ?? ''}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The chain, shown large, so nobody sends on the wrong one. */
export function ChainBanner({ chainId, name }: { chainId: number; name: string }) {
  const chain = chainById(chainId);
  return (
    <div className="chain-banner" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <ChainIcon chain={viewForChainId(chainId, name)} />
      <div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{name}</div>
        <div style={{ color: 'var(--stryx-sub)', fontSize: 12 }}>
          Chain ID {chainId} · {chain?.isTestnet ? 'Testnet' : 'Mainnet'}
        </div>
      </div>
    </div>
  );
}
