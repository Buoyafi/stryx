/** SeaDrop is deployed at the same address on every chain it supports (one CREATE2 deployment). */
export const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as const;

/** Partial ABI: the mint entry points and the reads needed to know a drop's state before minting. */
export const SEADROP_ABI = [
  {
    type: 'function',
    name: 'mintPublic',
    stateMutability: 'payable',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'minterIfNotPayer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mintAllowList',
    stateMutability: 'payable',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'minterIfNotPayer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
      {
        name: 'mintParams',
        type: 'tuple',
        components: [
          { name: 'mintPrice', type: 'uint256' },
          { name: 'maxTotalMintableByWallet', type: 'uint256' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'dropStageIndex', type: 'uint256' },
          { name: 'maxTokenSupplyForStage', type: 'uint256' },
          { name: 'feeBps', type: 'uint256' },
          { name: 'restrictFeeRecipients', type: 'bool' },
        ],
      },
      { name: 'proof', type: 'bytes32[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mintSigned',
    stateMutability: 'payable',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'minterIfNotPayer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
      {
        name: 'mintParams',
        type: 'tuple',
        components: [
          { name: 'mintPrice', type: 'uint256' },
          { name: 'maxTotalMintableByWallet', type: 'uint256' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'dropStageIndex', type: 'uint256' },
          { name: 'maxTokenSupplyForStage', type: 'uint256' },
          { name: 'feeBps', type: 'uint256' },
          { name: 'restrictFeeRecipients', type: 'bool' },
        ],
      },
      { name: 'salt', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getSigners',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getSignedMintValidationParams',
    stateMutability: 'view',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'signer', type: 'address' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'minMintPrice', type: 'uint80' },
          { name: 'maxMaxTotalMintableByWallet', type: 'uint24' },
          { name: 'minStartTime', type: 'uint40' },
          { name: 'maxEndTime', type: 'uint40' },
          { name: 'maxMaxTokenSupplyForStage', type: 'uint40' },
          { name: 'minFeeBps', type: 'uint16' },
          { name: 'maxFeeBps', type: 'uint16' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getPublicDrop',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'mintPrice', type: 'uint80' },
          { name: 'startTime', type: 'uint48' },
          { name: 'endTime', type: 'uint48' },
          { name: 'maxTotalMintableByWallet', type: 'uint16' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'restrictFeeRecipients', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getAllowListMerkleRoot',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getAllowedFeeRecipients',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getFeeRecipientIsAllowed',
    stateMutability: 'view',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  // Custom errors a mintPublic or mintAllowList call can revert with (ISeaDropErrorsAndEvents.sol).
  { type: 'error', name: 'NotActive', inputs: [
    { name: 'currentTimestamp', type: 'uint256' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
  ] },
  { type: 'error', name: 'MintQuantityCannotBeZero', inputs: [] },
  { type: 'error', name: 'MintQuantityExceedsMaxMintedPerWallet', inputs: [
    { name: 'total', type: 'uint256' },
    { name: 'allowed', type: 'uint256' },
  ] },
  { type: 'error', name: 'MintQuantityExceedsMaxSupply', inputs: [
    { name: 'total', type: 'uint256' },
    { name: 'maxSupply', type: 'uint256' },
  ] },
  { type: 'error', name: 'MintQuantityExceedsMaxTokenSupplyForStage', inputs: [
    { name: 'total', type: 'uint256' },
    { name: 'maxTokenSupplyForStage', type: 'uint256' },
  ] },
  { type: 'error', name: 'IncorrectPayment', inputs: [
    { name: 'got', type: 'uint256' },
    { name: 'want', type: 'uint256' },
  ] },
  { type: 'error', name: 'FeeRecipientCannotBeZeroAddress', inputs: [] },
  { type: 'error', name: 'FeeRecipientNotPresent', inputs: [] },
  // Thrown when `restrictFeeRecipients` is set and our feeRecipient is not on the on-chain allowlist.
  { type: 'error', name: 'FeeRecipientNotAllowed', inputs: [] },
  { type: 'error', name: 'DuplicateFeeRecipient', inputs: [] },
  // No inputs: declaring an argument here would compute a different selector, and the real revert
  // would never decode.
  { type: 'error', name: 'PayerNotAllowed', inputs: [] },
  // Thrown by `_splitPayout`: real, reachable whenever mintPrice != 0.
  { type: 'error', name: 'InvalidFeeBps', inputs: [{ name: 'feeBps', type: 'uint256' }] },
  // Also thrown by `_splitPayout` under the same condition as InvalidFeeBps.
  { type: 'error', name: 'CreatorPayoutAddressCannotBeZeroAddress', inputs: [] },
  { type: 'error', name: 'InvalidProof', inputs: [] },
  // mintSigned's own reverts: the signature checks and the per-signer bounds.
  { type: 'error', name: 'InvalidSignature', inputs: [{ name: 'recoveredSigner', type: 'address' }] },
  { type: 'error', name: 'SignatureAlreadyUsed', inputs: [] },
  { type: 'error', name: 'InvalidSignedMintPrice', inputs: [
    { name: 'got', type: 'uint256' },
    { name: 'minimum', type: 'uint256' },
  ] },
  { type: 'error', name: 'InvalidSignedMaxTotalMintableByWallet', inputs: [
    { name: 'got', type: 'uint256' },
    { name: 'maximum', type: 'uint256' },
  ] },
  { type: 'error', name: 'InvalidSignedStartTime', inputs: [
    { name: 'got', type: 'uint256' },
    { name: 'minimum', type: 'uint256' },
  ] },
  { type: 'error', name: 'InvalidSignedEndTime', inputs: [
    { name: 'got', type: 'uint256' },
    { name: 'maximum', type: 'uint256' },
  ] },
  { type: 'error', name: 'InvalidSignedMaxTokenSupplyForStage', inputs: [
    { name: 'got', type: 'uint256' },
    { name: 'maximum', type: 'uint256' },
  ] },
  { type: 'error', name: 'InvalidSignedFeeBps', inputs: [
    { name: 'got', type: 'uint256' },
    { name: 'minimumOrMaximum', type: 'uint256' },
  ] },
  { type: 'error', name: 'SignedMintsMustRestrictFeeRecipients', inputs: [] },
] as const;
