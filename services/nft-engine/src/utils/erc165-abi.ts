/**
 * ERC165's own interface ID and the ERC721 interface ID are fixed, standard constants. The SeaDrop
 * token interface ID is not included: its value could not be verified from a trustworthy source.
 */
export const ERC165_INTERFACE_ID = '0x01ffc9a7' as const;
export const ERC721_INTERFACE_ID = '0x80ac58cd' as const;

export const ERC165_ABI = [
  {
    type: 'function',
    name: 'supportsInterface',
    stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;
