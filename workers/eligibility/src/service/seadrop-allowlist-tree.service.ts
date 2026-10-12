import { computeAllowListLeafHash, hashPair } from '../utils/merkle-verify.util.js';
import type { AllowListEntry } from '../types/allowlist.types.js';
import type { MintParams } from '@stryx/nft-engine';

/**
 * Builds a SeaDrop-compatible allow-list Merkle tree: single-hash leaves, keccak256(abi.encode(minter,
 * mintParams)), and sorted-pair nodes. It does not use @openzeppelin/merkle-tree, whose double-hashed
 * leaves never verify against a SeaDrop root. A lone node is promoted unchanged. When a creator
 * publishes proofs, prefer EligibilityChecker.verifyGivenProof.
 */
export class SeaDropAllowListTree {
  private constructor(
    private readonly entries: readonly AllowListEntry[],
    private readonly layers: readonly (readonly `0x${string}`[])[],
  ) {}

  static build(entries: readonly AllowListEntry[]): SeaDropAllowListTree {
    if (entries.length === 0) {
      throw new Error('Cannot build a Merkle tree from an empty allow list');
    }

    const leaves = entries.map((e) => computeAllowListLeafHash(e.minter as `0x${string}`, e.mintParams));
    const layers = buildLayers(leaves);
    return new SeaDropAllowListTree(entries, layers);
  }

  /** Reconstructs a tree from a previous dump({ entries }): deterministic, since build() is pure. */
  static load(dump: { entries: AllowListEntry[] }): SeaDropAllowListTree {
    return SeaDropAllowListTree.build(dump.entries);
  }

  get root(): `0x${string}` {
    const topLayer = this.layers[this.layers.length - 1];
    if (!topLayer || topLayer.length === 0) {
      throw new Error('Tree has no layers: this should be unreachable since build() rejects empty entries');
    }
    return topLayer[0] as `0x${string}`;
  }

  dump(): { entries: AllowListEntry[] } {
    return { entries: [...this.entries] };
  }

  /** A wallet can be on the list for more than one stage. */
  getProofForMinter(
    minter: string,
    dropStageIndex?: number,
    atUnixSeconds?: number,
  ): { proof: `0x${string}`[]; mintParams: MintParams } | null {
    const target = minter.toLowerCase();

    const matches = this.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.minter.toLowerCase() === target && (dropStageIndex === undefined || entry.mintParams.dropStageIndex === dropStageIndex));
    if (matches.length === 0) return null;

    const at = atUnixSeconds;
    const open = at === undefined ? undefined : matches.find(({ entry }) => entry.mintParams.startTime <= at && at <= entry.mintParams.endTime);
    const next =
      at === undefined
        ? undefined
        : matches.filter(({ entry }) => entry.mintParams.startTime > at).sort((x, y) => x.entry.mintParams.startTime - y.entry.mintParams.startTime)[0];
    const { entry, index } = open ?? next ?? matches[0]!;

    return { proof: collectProof(this.layers, index), mintParams: entry.mintParams };
  }
}

/** Bottom-up layer construction. A lone node at any level is promoted unchanged, not duplicated. */
function buildLayers(leaves: readonly `0x${string}`[]): `0x${string}`[][] {
  const layers: `0x${string}`[][] = [[...leaves]];
  let current = layers[0]!;

  while (current.length > 1) {
    const next: `0x${string}`[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = current[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    layers.push(next);
    current = next;
  }

  return layers;
}

/** Walks up from a leaf index collecting the sibling at each level: the exact sequence verifyMerkleProof expects. */
function collectProof(layers: readonly (readonly `0x${string}`[])[], leafIndex: number): `0x${string}`[] {
  const proof: `0x${string}`[] = [];
  let index = leafIndex;

  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]!;
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;

    if (siblingIndex < layer.length) {
      proof.push(layer[siblingIndex]!);
    }
    // No sibling (this was a promoted lone node) -> no proof element added at this level.

    index = Math.floor(index / 2);
  }

  return proof;
}
