import { useQuery } from '@tanstack/react-query';
import { apiRequest } from './api';
import { isChainChoiceNeeded, resolveCollection, type CollectionImageRef } from './collection-resolve';

type DropReply = { openSea?: { collectionName?: string; imageUrl?: string | null } | null };

/** The existing GET /drops/:chainId/:contract, which adds OpenSea's name and image when it can. */
function useOpenSeaDrop<T>(chainId: number, contract: string, select: (drop: DropReply) => T) {
  return useQuery({
    queryKey: ['mint-ops', 'collection', chainId, contract.toLowerCase()],
    queryFn: () => apiRequest<DropReply>(`/drops/${chainId}/${contract}`),
    select,
    staleTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * The fallback: POST /resolve/collection, whose name comes from OpenSea or the contract's own name(),
 * and whose image comes from the contract's metadata.
 */
function useResolvedCollection(chainId: number, contract: string, enabled: boolean) {
  return useQuery({
    queryKey: ['collection-resolve', chainId, contract.toLowerCase()],
    queryFn: () => resolveCollection(contract, chainId),
    select: (r) => (isChainChoiceNeeded(r) ? null : r),
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** A collection's name for a list row: OpenSea's, else the collection's own, else null (callers show the address). */
export function useCollectionName(chainId: number, contract: string): { name: string | null; loading: boolean } {
  const openSea = useOpenSeaDrop(chainId, contract, (drop) => drop.openSea?.collectionName ?? null);
  const fromOpenSea = openSea.data ?? null;
  const resolved = useResolvedCollection(chainId, contract, (openSea.isFetched || openSea.isError) && !fromOpenSea);
  return { name: fromOpenSea ?? resolved.data?.name ?? null, loading: openSea.isLoading || resolved.isLoading };
}

/** The name and image OpenSea has for a drop (same one request as `useCollectionName`, shared by its cache). */
export function useCollectionInfo(chainId: number, contract: string): { name: string | null; imageUrl: string | null } {
  const openSea = useOpenSeaDrop(chainId, contract, (drop) => ({ name: drop.openSea?.collectionName ?? null, imageUrl: drop.openSea?.imageUrl ?? null }));
  const resolved = useResolvedCollection(chainId, contract, (openSea.isFetched || openSea.isError) && !openSea.data?.name);
  // The image stays OpenSea's only: the proof card paints it onto a canvas, which needs a CORS-clean URL.
  return { name: openSea.data?.name ?? resolved.data?.name ?? null, imageUrl: openSea.data?.imageUrl ?? null };
}

/** A collection's picture for a list row: OpenSea's image, else the one the contract's metadata points to. */
export function useCollectionImage(chainId: number, contract: string): CollectionImageRef | null {
  const openSea = useOpenSeaDrop(chainId, contract, (drop) => drop.openSea?.imageUrl ?? null);
  const fromOpenSea = openSea.data ?? null;
  const resolved = useResolvedCollection(chainId, contract, (openSea.isFetched || openSea.isError) && !fromOpenSea);
  if (fromOpenSea) return { kind: 'external', url: fromOpenSea };
  return resolved.data?.image ?? null;
}
