/**
 * Reads on ERC721SeaDrop, the NFT token contract itself, as distinct from SEADROP_ABI, the shared
 * contract every drop mints through. `getMintStats` lives on the token and counts per token, not per
 * stage.
 */
export const ERC721_SEADROP_TOKEN_ABI = [
  {
    type: 'function',
    name: 'getMintStats',
    stateMutability: 'view',
    inputs: [{ name: 'minter', type: 'address' }],
    outputs: [
      { name: 'minterNumMinted', type: 'uint256' },
      { name: 'currentTotalSupply', type: 'uint256' },
      { name: 'maxSupply', type: 'uint256' },
    ],
  },
] as const;
