import { computeAllowListLeafHash, verifyMerkleProof } from '../utils/merkle-verify.util.js';
import type { SeaDropAllowListTree } from './seadrop-allowlist-tree.service.js';
import type { EligibilityResult } from '../types/allowlist.types.js';
import type { MintParams } from '@stryx/nft-engine';

/**
 * Checks whether a wallet may mint an allow-list stage and produces its proof. The wallet must be in
 * the tree, the tree's root must match the one on chain now, and the proof must pass an independent
 * verifier: a wrong proof costs a reverted mint.
 */
export class EligibilityChecker {
  checkEligibility(
    tree: SeaDropAllowListTree,
    onChainMerkleRoot: `0x${string}`,
    minter: string,
    dropStageIndex?: number,
    /** With no stage named: the moment to pick the wallet's stage for (see getProofForMinter). */
    atUnixSeconds?: number,
  ): EligibilityResult {
    if (tree.root.toLowerCase() !== onChainMerkleRoot.toLowerCase()) {
      return { eligible: false, reason: 'root_mismatch' };
    }

    const entry = tree.getProofForMinter(minter, dropStageIndex, atUnixSeconds);
    if (!entry) {
      return { eligible: false, reason: 'not_on_list' };
    }

    return this.verifyGivenProof(minter, entry.mintParams, entry.proof, onChainMerkleRoot);
  }

  /** Verifies a proof that came from elsewhere, such as the drop creator's published allow list. */
  verifyGivenProof(
    minter: string,
    mintParams: MintParams,
    proof: readonly `0x${string}`[],
    onChainMerkleRoot: `0x${string}`,
  ): EligibilityResult {
    const leaf = computeAllowListLeafHash(minter as `0x${string}`, mintParams);
    const verified = verifyMerkleProof(leaf, proof, onChainMerkleRoot);

    if (!verified) {
      return { eligible: false, reason: 'proof_failed_local_verification' };
    }

    return { eligible: true, mintParams, proof: [...proof] };
  }
}
