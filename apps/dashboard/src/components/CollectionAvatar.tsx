import { ChainIcon } from '@stryx/chain-ui/react';
import { viewForChainId } from '@stryx/chain-ui';
import { chainById } from '@stryx/chains';
import { CollectionThumb } from './CollectionThumb';
import { useCollectionImage } from '../lib/useCollectionName';

/** A collection's picture with its chain as a small badge: OpenSea's image, else the contract metadata's, else a monogram. */
export function CollectionAvatar({ chainId, contract, name, chainName, size = 44 }: { chainId: number; contract: string; name: string | null; chainName?: string; size?: number }) {
  const image = useCollectionImage(chainId, contract);
  return (
    <span className="coll-avatar">
      <CollectionThumb image={image} name={name} contract={contract} size={size} />
      <span className="coll-avatar__chain">
        <ChainIcon chain={viewForChainId(chainId, chainName ?? chainById(chainId)?.name)} interactive={false} />
      </span>
    </span>
  );
}
