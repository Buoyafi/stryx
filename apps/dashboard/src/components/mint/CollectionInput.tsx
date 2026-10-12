import { useEffect, useRef, useState } from 'react';
import { ChainPicker } from '../disperse/ChainPicker';
import { CollectionThumb } from '../CollectionThumb';
import { isChainChoiceNeeded, resolveCollection, type ResolvedCollection } from '../../lib/collection-resolve';
import { readRecentCollections, type RecentCollection } from '../../lib/recent-collections-store';
import { ApiError } from '../../lib/api';
import { Notice } from '../Notice';

const short = (contract: string) => `${contract.slice(0, 8)}…${contract.slice(-4)}`;

/**
 * The single entry point for the mint page: paste an OpenSea link, a slug, or a bare contract address,
 * and it resolves to a collection.
 */
export function CollectionInput({ onResolved, initialValue }: { onResolved: (input: string, resolved: ResolvedCollection) => void; initialValue?: string }) {
  const [value, setValue] = useState(initialValue ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chainChoice, setChainChoice] = useState<{ input: string; contract: string; chains: { chainId: number; name: string }[] } | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const recent = readRecentCollections();

  // Only the newest lookup may write its answer: a slow earlier one must not replace what is on screen.
  const latest = useRef(0);

  async function submit(input: string, chainId?: number) {
    const trimmed = input.trim();
    if (!trimmed) return;
    const mine = ++latest.current;
    setLoading(true);
    setError(null);
    setChainChoice(null);
    try {
      const result = await resolveCollection(trimmed, chainId);
      if (mine !== latest.current) return;
      if (isChainChoiceNeeded(result)) {
        setChainChoice({ input: trimmed, contract: result.contract, chains: result.chains });
        return;
      }
      onResolved(trimmed, result);
      setRecentOpen(false);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError) {
        const body = err.body as { message?: string; error?: string } | null;
        setError(body?.message ?? body?.error ?? `Could not resolve that (HTTP ${err.status}).`);
      } else {
        setError('Could not reach the API.');
      }
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }

  // Arriving from a Home page drop (/mint?collection=...): look it up straight away, once.
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (!initialValue || autoSubmitted.current) return;
    autoSubmitted.current = true;
    void submit(initialValue);
  }, [initialValue]);

  return (
    <div style={{ position: 'relative', maxWidth: 640 }}>
      <label htmlFor="collection-input" style={{ fontSize: 12, color: 'var(--stryx-sub)', marginBottom: 6, display: 'block' }}>
        OpenSea link, collection slug, or contract address
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          id="collection-input"
          className="mono"
          placeholder="https://opensea.io/collection/… or 0x…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setRecentOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit(value);
          }}
          style={{ flex: 1 }}
        />
        <button type="button" className="primary" disabled={loading || value.trim() === ''} onClick={() => void submit(value)}>
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </div>

      {error && (
        <Notice tone="error">{error}</Notice>
      )}

      {chainChoice && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: 12.5, marginBottom: 8 }}>
            {short(chainChoice.contract)} has contract code on more than one chain. Which one?
          </p>
          <ChainPicker chains={chainChoice.chains} value={null} onChange={(chainId) => void submit(chainChoice.input, chainId)} />
        </div>
      )}

      {recentOpen && !chainChoice && recent.length > 0 && (
        <div
          role="listbox"
          aria-label="Recent collections"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            zIndex: 20,
            background: 'var(--stryx-card)',
            border: '1px solid var(--dash-line-strong)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--dash-shadow)',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--dash-line-strong)' }}>
            <span style={{ fontSize: 11, color: 'var(--stryx-sub)' }}>Recent collections</span>
            <button type="button" onClick={() => setRecentOpen(false)} style={{ fontSize: 11, padding: '2px 6px', border: 'none', background: 'transparent', color: 'var(--stryx-sub)' }}>
              Close
            </button>
          </div>
          {recent.map((r: RecentCollection) => (
            <button
              key={`${r.chainId}:${r.contract}`}
              type="button"
              role="option"
              onClick={() => {
                setValue(r.input);
                void submit(r.input);
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                border: 'none',
                borderRadius: 0,
                background: 'transparent',
                textAlign: 'left',
              }}
            >
              <CollectionThumb image={r.imageUrl ? { kind: 'external', url: r.imageUrl } : null} name={r.name} contract={r.contract} size={24} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name ?? short(r.contract)}</span>
                <span style={{ fontSize: 11, color: 'var(--stryx-sub)' }}>{r.chainName}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
