import {
  decodeFunctionData,
  recoverTypedDataAddress,
  compactSignatureToSignature,
  parseCompactSignature,
  size,
  type Hex,
} from 'viem';
import { SEADROP_ABI, SEADROP_ADDRESS } from './seadrop-abi.js';
import type { MintParams } from '../types/seadrop.types.js';

/** Every argument of one `mintSigned` call, decoded. */
export interface SignedMintPayload {
  nftContract: `0x${string}`;
  feeRecipient: `0x${string}`;
  minterIfNotPayer: `0x${string}`;
  quantity: number;
  mintParams: MintParams;
  salt: bigint;
  signature: `0x${string}`;
}

export class SignedMintDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignedMintDecodeError';
  }
}

/** Decodes calldata that must be a SeaDrop `mintSigned` call. */
export function decodeMintSignedCalldata(calldata: Hex): SignedMintPayload {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: SEADROP_ABI, data: calldata });
  } catch {
    throw new SignedMintDecodeError('Calldata did not decode as a known SeaDrop function.');
  }
  if (decoded.functionName !== 'mintSigned') {
    throw new SignedMintDecodeError(`Expected a mintSigned call but got "${decoded.functionName}".`);
  }

  const [nftContract, feeRecipient, minterIfNotPayer, quantity, raw, salt, signature] = decoded.args;
  return {
    nftContract,
    feeRecipient,
    minterIfNotPayer,
    quantity: Number(quantity),
    mintParams: {
      mintPrice: raw.mintPrice,
      maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
      startTime: Number(raw.startTime),
      endTime: Number(raw.endTime),
      dropStageIndex: Number(raw.dropStageIndex),
      maxTokenSupplyForStage: raw.maxTokenSupplyForStage,
      feeBps: Number(raw.feeBps),
      restrictFeeRecipients: raw.restrictFeeRecipients,
    },
    salt,
    signature,
  };
}

/**
 * The EIP-712 typed data SeaDrop hashes in `_getDigest` (SeaDrop.sol): domain ("SeaDrop", "1.0",
 * chainId, the SeaDrop contract), primary type `SignedMint`.
 */
export function signedMintTypedData(params: {
  chainId: number;
  nftContract: `0x${string}`;
  minter: `0x${string}`;
  feeRecipient: `0x${string}`;
  mintParams: MintParams;
  salt: bigint;
}) {
  return {
    domain: { name: 'SeaDrop', version: '1.0', chainId: params.chainId, verifyingContract: SEADROP_ADDRESS },
    types: {
      SignedMint: [
        { name: 'nftContract', type: 'address' },
        { name: 'minter', type: 'address' },
        { name: 'feeRecipient', type: 'address' },
        { name: 'mintParams', type: 'MintParams' },
        { name: 'salt', type: 'uint256' },
      ],
      MintParams: [
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
    primaryType: 'SignedMint' as const,
    message: {
      nftContract: params.nftContract,
      minter: params.minter,
      feeRecipient: params.feeRecipient,
      mintParams: {
        mintPrice: params.mintParams.mintPrice,
        maxTotalMintableByWallet: BigInt(params.mintParams.maxTotalMintableByWallet),
        startTime: BigInt(params.mintParams.startTime),
        endTime: BigInt(params.mintParams.endTime),
        dropStageIndex: BigInt(params.mintParams.dropStageIndex),
        maxTokenSupplyForStage: params.mintParams.maxTokenSupplyForStage,
        feeBps: BigInt(params.mintParams.feeBps),
        restrictFeeRecipients: params.mintParams.restrictFeeRecipients,
      },
      salt: params.salt,
    },
  };
}

/** Recovers the address that signed a `mintSigned` payload for `minter`, locally, with no chain call. */
export async function recoverSignedMintSigner(chainId: number, minter: `0x${string}`, payload: SignedMintPayload): Promise<`0x${string}`> {
  const signature =
    size(payload.signature) === 64 ? compactSignatureToSignature(parseCompactSignature(payload.signature)) : payload.signature;
  return recoverTypedDataAddress({
    ...signedMintTypedData({
      chainId,
      nftContract: payload.nftContract,
      minter,
      feeRecipient: payload.feeRecipient,
      mintParams: payload.mintParams,
      salt: payload.salt,
    }),
    signature,
  });
}
