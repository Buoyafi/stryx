import { encodeFunctionData, zeroAddress } from 'viem';
import { SEADROP_ADDRESS, SEADROP_ABI } from '../utils/seadrop-abi.js';
import type { MintParams, SeaDropMintScope } from '../types/seadrop.types.js';

export interface UnsignedTransactionRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

/** Builds the exact calldata + value for a SeaDrop mint. */
export class SeaDropTransactionBuilder {
  /**
   * Builds a public-stage mint. `minterIfNotPayer` is always the zero address: the signing wallet both
   * pays for and receives its mint, and any other value makes SeaDrop check a payer allowlist and
   * revert with PayerNotAllowed.
   */
  buildMintPublicTx(
    scope: SeaDropMintScope,
    feeRecipient: `0x${string}`,
    quantity: number,
    mintPriceWei: bigint,
  ): UnsignedTransactionRequest {
    const data = encodeFunctionData({
      abi: SEADROP_ABI,
      functionName: 'mintPublic',
      args: [scope.nftContract as `0x${string}`, feeRecipient, zeroAddress, BigInt(quantity)],
    });

    return { to: SEADROP_ADDRESS, data, value: mintPriceWei * BigInt(quantity) };
  }

  /** Builds an allow-list stage mint. `mintParams` must match the stage's on-chain configuration exactly, or the call reverts. */
  buildMintAllowListTx(
    scope: SeaDropMintScope,
    feeRecipient: `0x${string}`,
    quantity: number,
    mintParams: MintParams,
    proof: readonly `0x${string}`[],
  ): UnsignedTransactionRequest {
    const data = encodeFunctionData({
      abi: SEADROP_ABI,
      functionName: 'mintAllowList',
      args: [
        scope.nftContract as `0x${string}`,
        feeRecipient,
        zeroAddress,
        BigInt(quantity),
        toAbiMintParams(mintParams),
        [...proof],
      ],
    });

    return { to: SEADROP_ADDRESS, data, value: mintParams.mintPrice * BigInt(quantity) };
  }

  /** Builds a signed-stage mint (`mintSigned`). */
  buildMintSignedTx(
    scope: SeaDropMintScope,
    feeRecipient: `0x${string}`,
    quantity: number,
    mintParams: MintParams,
    salt: bigint,
    signature: `0x${string}`,
  ): UnsignedTransactionRequest {
    const data = encodeFunctionData({
      abi: SEADROP_ABI,
      functionName: 'mintSigned',
      args: [
        scope.nftContract as `0x${string}`,
        feeRecipient,
        zeroAddress,
        BigInt(quantity),
        toAbiMintParams(mintParams),
        salt,
        signature,
      ],
    });

    return { to: SEADROP_ADDRESS, data, value: mintParams.mintPrice * BigInt(quantity) };
  }
}

function toAbiMintParams(mintParams: MintParams) {
  return {
    mintPrice: mintParams.mintPrice,
    maxTotalMintableByWallet: BigInt(mintParams.maxTotalMintableByWallet),
    startTime: BigInt(mintParams.startTime),
    endTime: BigInt(mintParams.endTime),
    dropStageIndex: BigInt(mintParams.dropStageIndex),
    maxTokenSupplyForStage: mintParams.maxTokenSupplyForStage,
    feeBps: BigInt(mintParams.feeBps),
    restrictFeeRecipients: mintParams.restrictFeeRecipients,
  };
}
