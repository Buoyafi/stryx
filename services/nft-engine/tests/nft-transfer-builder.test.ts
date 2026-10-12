import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress } from 'viem';
import { NftTransferBuilder } from '../src/service/nft-transfer-builder.service.js';
import { ERC721_ABI } from '../src/utils/erc721-abi.js';
import { ERC1155_ABI } from '../src/utils/erc1155-abi.js';

const CONTRACT = getAddress('0x1234567890123456789012345678901234567890');
const FROM = getAddress('0x1111111111111111111111111111111111111111');
const TO = getAddress('0x2222222222222222222222222222222222222222');

describe('NftTransferBuilder', () => {
  it('builds an ERC-721 transfer with zero value and the right destination', () => {
    const builder = new NftTransferBuilder();
    const tx = builder.buildErc721Transfer(CONTRACT, FROM, TO, 42n);

    expect(tx.to).toBe(CONTRACT);
    expect(tx.value).toBe(0n);
  });

  it('encodes ERC-721 safeTransferFrom calldata that decodes back to the exact arguments', () => {
    const builder = new NftTransferBuilder();
    const tx = builder.buildErc721Transfer(CONTRACT, FROM, TO, 42n);

    const decoded = decodeFunctionData({ abi: ERC721_ABI, data: tx.data });
    expect(decoded.functionName).toBe('safeTransferFrom');
    expect(decoded.args).toEqual([FROM, TO, 42n]);
  });

  it('builds an ERC-1155 transfer with zero value', () => {
    const builder = new NftTransferBuilder();
    const tx = builder.buildErc1155Transfer(CONTRACT, FROM, TO, 7n, 3n);

    expect(tx.to).toBe(CONTRACT);
    expect(tx.value).toBe(0n);
  });

  it('encodes ERC-1155 safeTransferFrom calldata with the exact tokenId and amount, empty data', () => {
    const builder = new NftTransferBuilder();
    const tx = builder.buildErc1155Transfer(CONTRACT, FROM, TO, 7n, 3n);

    const decoded = decodeFunctionData({ abi: ERC1155_ABI, data: tx.data });
    expect(decoded.functionName).toBe('safeTransferFrom');
    expect(decoded.args).toEqual([FROM, TO, 7n, 3n, '0x']);
  });
});
