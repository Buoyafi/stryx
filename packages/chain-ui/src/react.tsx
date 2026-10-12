import { useEffect, useRef } from 'react';
import { iconParts } from './icons.js';
import { viewForChainId, type ChainView, type TooltipRow } from './core.js';
import { mountChainTooltips, type ChainStatus } from './dom.js';

/** The same icon as chainIconMarkup, as React. */
export function ChainIcon({
  chain,
  interactive = true,
  status,
  size,
}: {
  chain: ChainView;
  interactive?: boolean;
  status?: ChainStatus;
  size?: 'sm';
}) {
  const { url, initials, showTestnetBadge } = iconParts(chain);
  const className = `chain-icon${size === 'sm' ? ' chain-icon--sm' : ''}`;
  const inner = (
    <>
      {url ? (
        <img className="chain-icon__img" src={url} alt="" width={28} height={28} decoding="async" draggable={false} />
      ) : (
        <span className="chain-icon__fallback" aria-hidden="true">
          {initials}
        </span>
      )}
      {showTestnetBadge && (
        <span className="chain-icon__badge" aria-hidden="true">
          T
        </span>
      )}
      {status && <span className={`chain-icon__dot chain-icon__dot--${status}`} aria-hidden="true" />}
    </>
  );
  if (!interactive) {
    return (
      <span className={className} aria-hidden="true">
        {inner}
      </span>
    );
  }
  return (
    <button type="button" className={className} data-chain-id={chain.chainId} aria-label={chain.name}>
      {inner}
    </button>
  );
}

/** Mount once near the root of an app. */
export function ChainTooltip({ extraRows }: { extraRows?: (chain: ChainView) => readonly TooltipRow[] }) {
  const latest = useRef(extraRows);
  latest.current = extraRows;

  useEffect(() => {
    const controller = mountChainTooltips({
      resolve: (chainId) => {
        const chain = viewForChainId(chainId);
        const rows = latest.current?.(chain);
        return rows ? { chain, extraRows: rows } : { chain };
      },
    });
    return () => controller.destroy();
  }, []);

  return null;
}
