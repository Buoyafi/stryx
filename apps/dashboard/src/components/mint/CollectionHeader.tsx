import { useQuery } from '@tanstack/react-query';
import { CollectionThumb } from '../CollectionThumb';
import { CopyableValue } from '../CopyableValue';
import { fetchCollectionSupply, type ResolvedCollection } from '../../lib/collection-resolve';

/** How often the header's progress bar refreshes. */
const SUPPLY_REFRESH_MS = 15_000;

/**
 * The resolved collection, always visible at the top of the mint page: thumbnail, name (linked to
 * OpenSea when a link exists), the contract (short, with copy), the chain, and a minted/total progress
 * bar that keeps itself current.
 */
export function CollectionHeader({ collection }: { collection: ResolvedCollection }) {
  const { data } = useQuery({
    queryKey: ['collection-supply', collection.chainId, collection.contract],
    queryFn: () => fetchCollectionSupply(collection.chainId, collection.contract),
    enabled: collection.mintableHere,
    refetchInterval: SUPPLY_REFRESH_MS,
    // Show the resolve response's own numbers immediately, refresh from here.
    initialData: collection.mintableHere ? { chainId: collection.chainId, contract: collection.contract, mintedCount: collection.mintedCount, maxSupply: collection.maxSupply, fetchedAt: Date.now(), cached: false } : undefined,
  });

  const mintedCount = data?.mintedCount ?? collection.mintedCount;
  const maxSupply = data?.maxSupply ?? collection.maxSupply;
  const hasSupply = mintedCount !== null && maxSupply !== null && maxSupply > 0;
  const pct = hasSupply ? Math.min(100, Math.round((mintedCount! / maxSupply!) * 100)) : 0;

  return (
    <section
      aria-label="Collection"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: 16,
        border: '1px solid var(--dash-line-strong)',
        borderRadius: 'var(--radius)',
        background: 'var(--stryx-card)',
        marginTop: 16,
        maxWidth: 640,
      }}
    >
      <CollectionThumb image={collection.image} name={collection.name} contract={collection.contract} size={56} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          {collection.openSeaUrl ? (
            <a href={collection.openSeaUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: 15, fontWeight: 700 }}>
              {collection.name ?? 'Unnamed collection'}
              <span aria-hidden> ↗</span>
              <span className="sr-only"> (opens on OpenSea)</span>
            </a>
          ) : (
            <span style={{ fontSize: 15, fontWeight: 700 }}>{collection.name ?? 'Unnamed collection'}</span>
          )}
          <span style={{ fontSize: 12, color: 'var(--stryx-sub)' }}>{collection.chainName}</span>
        </div>

        <div style={{ marginTop: 2 }}>
          <CopyableValue value={collection.contract} />
        </div>

        {collection.note && (
          <p style={{ fontSize: 12, color: 'var(--stryx-sub)', marginTop: 4 }}>{collection.note}</p>
        )}

        {collection.mintableHere && (
          <div style={{ marginTop: 8 }}>
            {hasSupply ? (
              <>
                <div
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${mintedCount} of ${maxSupply} minted`}
                  style={{ height: 6, borderRadius: 4, background: 'var(--dash-raised)', overflow: 'hidden' }}
                >
                  <div style={{ height: '100%', width: `${pct}%`, background: 'var(--stryx-accent)', transition: 'width 0.3s' }} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--stryx-sub)', marginTop: 4 }}>
                  {mintedCount!.toLocaleString()} / {maxSupply!.toLocaleString()} minted ({pct}%)
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--stryx-sub)' }}>Supply unavailable</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
