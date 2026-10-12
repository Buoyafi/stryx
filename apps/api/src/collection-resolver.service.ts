import { chainById } from './chain-registry.js';
import { seaDropMissingMessage } from './seadrop-support.js';
import type { ChainServices } from './chain-services.js';
import { probeChainsForContract, type ChainWithContract } from './contract-chain-probe.js';
import { OpenSeaResolver, OpenSeaResolveError } from './opensea-resolver.js';
import type { OpenSeaDropInfo } from './opensea-drop-info.js';

/** ERC721's standard `name()`. */
const ERC721_NAME_ABI = [{ type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const;

export type CollectionResolveErrorCode = 'invalid_input' | 'contract_not_found';

export class CollectionResolveError extends Error {
  constructor(
    public readonly code: CollectionResolveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CollectionResolveError';
  }
}

export interface CollectionHeaderImage {
  /** `external`: hotlink `url` directly (OpenSea's own CDN). */
  kind: 'external' | 'proxied';
  url: string;
}

export interface ResolvedCollection {
  contract: `0x${string}`;
  chainId: number;
  chainName: string;
  slug?: string;
  openSeaUrl: string | null;
  name: string | null;
  image: CollectionHeaderImage | null;
  mintedCount: number | null;
  maxSupply: number | null;
  mintableHere: boolean;
  note?: string;
}

export interface ChainChoiceNeeded {
  needsChainChoice: true;
  contract: `0x${string}`;
  chains: ChainWithContract[];
}

export type CollectionResolution = ResolvedCollection | ChainChoiceNeeded;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface CollectionResolverDeps {
  openSeaResolver: OpenSeaResolver;
  chainServices: ReadonlyMap<number, ChainServices>;
  /** (chainId, contract) -> best-effort OpenSea enrichment, or null. */
  fetchDropInfo: (chainId: number, contract: string) => Promise<OpenSeaDropInfo | null>;
}

/**
 * The single entry point for what the operator pasted: an OpenSea collection or asset URL, a bare
 * slug, or a contract address.
 */
export class CollectionResolverService {
  constructor(private readonly deps: CollectionResolverDeps) {}

  async resolve(input: string, chainId?: number): Promise<CollectionResolution> {
    const trimmed = input.trim();
    if (trimmed === '') throw new CollectionResolveError('invalid_input', 'Paste an OpenSea link, a collection slug, or a contract address.');

    if (ADDRESS_RE.test(trimmed)) {
      return this.resolveAddress(trimmed as `0x${string}`, chainId);
    }

    // Not address-shaped: OpenSeaResolver handles a URL or a slug, and throws a clear error for
    // anything else.
    const resolved = await this.deps.openSeaResolver.resolve(trimmed);
    if (resolved.chainId === null) {
      throw new CollectionResolveError('invalid_input', `Resolved to chain "${resolved.chainName}", which this platform does not support.`);
    }
    return this.assemble(resolved.contract, resolved.chainId, resolved.slug);
  }

  private async resolveAddress(contract: `0x${string}`, chainId?: number): Promise<CollectionResolution> {
    if (chainId !== undefined) {
      const services = this.deps.chainServices.get(chainId);
      if (!services) throw new CollectionResolveError('contract_not_found', `Chain ${chainId} has no RPC configured on this instance.`);
      const found = await probeChainsForContract(contract, new Map([[chainId, services]]));
      if (found.length === 0) {
        throw new CollectionResolveError('contract_not_found', `No contract code found at ${contract} on chain ${chainId}.`);
      }
      return this.assemble(contract, chainId);
    }

    const chains = await probeChainsForContract(contract, this.deps.chainServices);
    if (chains.length === 0) {
      throw new CollectionResolveError('contract_not_found', `No contract code found at ${contract} on any chain this instance is configured for.`);
    }
    if (chains.length > 1) {
      return { needsChainChoice: true, contract, chains };
    }
    return this.assemble(contract, chains[0]!.chainId);
  }

  private async assemble(contract: `0x${string}`, chainId: number, slugHint?: string): Promise<ResolvedCollection> {
    const chain = chainById(chainId);
    const chainName = chain?.name ?? `Chain ${chainId}`;
    const hasRpc = this.deps.chainServices.has(chainId);
    const seaDrop = hasRpc ? await this.deps.chainServices.get(chainId)!.seaDropSupport?.isDeployed() : undefined;
    const mintableHere = hasRpc && seaDrop !== false;
    const openSeaUrl = chain?.openSeaChainName ? `https://opensea.io/assets/${chain.openSeaChainName}/${contract}` : null;

    // An injected dependency: guard it even though the real one never throws.
    const dropInfo = await this.deps.fetchDropInfo(chainId, contract).catch(() => null);

    let mintedCount: number | null = dropInfo?.totalSupply ?? null;
    let maxSupply: number | null = dropInfo?.maxSupply ?? null;
    let name: string | null = dropInfo?.collectionName ?? null;

    if (hasRpc) {
      const services = this.deps.chainServices.get(chainId)!;
      // The chain wins when it is readable: OpenSea's number can lag or not exist.
      try {
        const stats = await services.seaDropReader.getMintStats({ nftContract: contract, chainId }, '0x0000000000000000000000000000000000000000');
        mintedCount = Number(stats.currentTotalSupply);
        maxSupply = Number(stats.maxSupply);
      } catch {
        // Not a SeaDrop contract, or the read failed: leave whatever OpenSea gave us (possibly still null).
      }
      if (!name) {
        try {
          name = await services.publicClient.readContract({ address: contract, abi: ERC721_NAME_ABI, functionName: 'name', args: [] });
        } catch {
          // No name() either, or it reverted: header shows the contract address instead.
        }
      }
    }

    const image: CollectionHeaderImage | null = dropInfo?.imageUrl
      ? { kind: 'external', url: dropInfo.imageUrl }
      : hasRpc
        ? { kind: 'proxied', url: `/chains/${chainId}/collections/${contract}/image` }
        : null;

    return {
      contract,
      chainId,
      chainName,
      ...(slugHint || dropInfo?.collectionSlug ? { slug: slugHint ?? dropInfo!.collectionSlug } : {}),
      openSeaUrl,
      name,
      image,
      mintedCount,
      maxSupply,
      mintableHere,
      ...(collectionNote(chainName, { hasRpc, seaDropMissing: seaDrop === false, onOpenSea: !!chain?.openSeaChainName }) ?? {}),
    };
  }
}

/** What the header says under the collection, most important first: no RPC, SeaDrop missing, then not on OpenSea. */
function collectionNote(chainName: string, f: { hasRpc: boolean; seaDropMissing: boolean; onOpenSea: boolean }): { note: string } | null {
  if (!f.hasRpc) return { note: `Chain ${chainName} has no RPC configured on this instance, so live supply cannot be read.` };
  if (f.seaDropMissing) return { note: seaDropMissingMessage(chainName) };
  if (!f.onOpenSea) return { note: `OpenSea doesn't support ${chainName}, so phases come from the contract alone (paste a contract address for this chain).` };
  return null;
}

export { OpenSeaResolveError };
