import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';

export interface ChainChoice {
  chainId: number;
  name: string;
}

/** One button per chain, with the shared chain icon. */
export function ChainPicker({ chains, value, onChange }: { chains: readonly ChainChoice[]; value: number | null; onChange: (chainId: number) => void }) {
  return (
    <div className="chain-picker" role="radiogroup" aria-label="Chain" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {chains.map((c, i) => {
        const selected = value === c.chainId;
        const focusable = selected || (value === null && i === 0);
        return (
          <button
            key={c.chainId}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={focusable ? 0 : -1}
            data-chain-id={c.chainId}
            onClick={() => onChange(c.chainId)}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = chains[(i + step + chains.length) % chains.length]!;
              onChange(next.chainId);
              (e.currentTarget.parentElement?.querySelector(`[data-chain-id="${next.chainId}"]`) as HTMLElement | null)?.focus();
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              borderColor: selected ? 'var(--stryx-accent)' : 'var(--dash-line-strong)',
              background: selected ? 'var(--dash-raised)' : 'transparent',
            }}
          >
            <ChainIcon chain={viewForChainId(c.chainId, c.name)} interactive={false} size="sm" />
            {c.name}
          </button>
        );
      })}
    </div>
  );
}
