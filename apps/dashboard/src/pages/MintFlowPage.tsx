import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { chainById } from '@stryx/chains';
import { CollectionInput } from '../components/mint/CollectionInput';
import { CollectionHeader } from '../components/mint/CollectionHeader';
import { PhaseList } from '../components/mint/PhaseList';
import { DirectProofMint } from '../components/mint/DirectProofMint';
import { VaultSettingsPanel } from '../components/mint/VaultSettingsPanel';
import { addRecentCollection, toRecentCollectionEntry } from '../lib/recent-collections-store';
import type { ResolvedCollection } from '../lib/collection-resolve';

/**
 * The single mint page: resolve a collection, see every phase of its drop, check each wallet's
 * eligibility, then mint now or schedule.
 */
export function MintFlowPage() {
  const [collection, setCollection] = useState<ResolvedCollection | null>(null);
  // Set by the Home page's "Open in Mint" link.
  const [searchParams] = useSearchParams();
  const initialCollection = searchParams.get('collection')?.trim() || undefined;
  const dropKey = collection ? `${collection.chainId}:${collection.contract.toLowerCase()}` : '';

  return (
    <div>
      <h1 style={{ fontSize: 18, marginBottom: 6 }}>Mint</h1>
      <p style={{ color: 'var(--stryx-sub)', marginBottom: 20, fontSize: 12.5 }}>
        Paste an OpenSea link, a collection slug, or a contract address to look up a drop.
      </p>

      <CollectionInput
        {...(initialCollection ? { initialValue: initialCollection } : {})}
        onResolved={(input, resolved) => {
          setCollection(resolved);
          addRecentCollection(toRecentCollectionEntry(input, resolved));
        }}
      />

      {collection && <CollectionHeader collection={collection} />}
      {/* Keyed by the collection: selections, pasted proofs and results belong to one drop and must not carry into the next. */}
      {collection && collection.mintableHere && (
        <PhaseList key={`phases:${dropKey}`} chainId={collection.chainId} contract={collection.contract} symbol={chainById(collection.chainId)?.nativeCurrency.symbol ?? ''} slug={collection.slug ?? null} />
      )}
      {collection && collection.mintableHere && <DirectProofMint key={`proof:${dropKey}`} chainId={collection.chainId} nftContract={collection.contract} />}
      {collection && collection.mintableHere && <VaultSettingsPanel key={`vault:${collection.chainId}`} chainId={collection.chainId} />}
    </div>
  );
}
