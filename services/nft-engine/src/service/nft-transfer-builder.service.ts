import { encodeFunctionData } from 'viem';
import { ERC721_ABI } from '../utils/erc721-abi.js';
import { ERC1155_ABI } from '../utils/erc1155-abi.js';
import type { UnsignedTransactionRequest } from './seadrop-tx-builder.service.js';

/** Builds the exact calldata + value for moving one token out of a custodial wallet. */
export class NftTransferBuilder {
  buildErc721Transfer(
    contract: `0x${string}`,
    from: `0x${string}`,
    to: `0x${string}`,
    tokenId: bigint,
  ): UnsignedTransactionRequest {
    const data = encodeFunctionData({ abi: ERC721_ABI, functionName: 'safeTransferFrom', args: [from, to, tokenId] });
    return { to: contract, data, value: 0n };
  }

  buildErc1155Transfer(
    contract: `0x${string}`,
    from: `0x${string}`,
    to: `0x${string}`,
    tokenId: bigint,
    amount: bigint,
  ): UnsignedTransactionRequest {
    const data = encodeFunctionData({
      abi: ERC1155_ABI,
      functionName: 'safeTransferFrom',
      args: [from, to, tokenId, amount, '0x'],
    });
    return { to: contract, data, value: 0n };
  }
}
