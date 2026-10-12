import { encodeAbiParameters, keccak256 } from 'viem';
import type { MintParams } from '@stryx/nft-engine';

/**
 * OpenZeppelin's MerkleProof verification, reimplemented independently of the package that builds the
 * tree, so a proof is checked by different code than made it.
 */
export function verifyMerkleProof(leaf: `0x${string}`, proof: readonly `0x${string}`[], root: `0x${string}`): boolean {
  let computedHash = leaf;

  for (const proofElement of proof) {
    computedHash = hashPair(computedHash, proofElement);
  }

  return computedHash.toLowerCase() === root.toLowerCase();
}

export function hashPair(a: `0x${string}`, b: `0x${string}`): `0x${string}` {
  const [first, second] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [first, second]));
}

/**
 * The SeaDrop allow-list leaf hash for a (minter, mintParams) pair: `keccak256(abi.encode(minter,
 * mintParams))`, as in SeaDrop.sol's `_mintAllowList`.
 */
export function computeAllowListLeafHash(minter: `0x${string}`, mintParams: MintParams): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bool' },
      ],
      [
        minter,
        mintParams.mintPrice,
        BigInt(mintParams.maxTotalMintableByWallet),
        BigInt(mintParams.startTime),
        BigInt(mintParams.endTime),
        BigInt(mintParams.dropStageIndex),
        mintParams.maxTokenSupplyForStage,
        BigInt(mintParams.feeBps),
        mintParams.restrictFeeRecipients,
      ],
    ),
  );
}
