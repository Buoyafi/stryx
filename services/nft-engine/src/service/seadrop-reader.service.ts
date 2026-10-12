import type { PublicClient } from 'viem';
import { withTimeout } from '@stryx/utils';
import { SEADROP_ADDRESS, SEADROP_ABI } from '../utils/seadrop-abi.js';
import { ERC721_SEADROP_TOKEN_ABI } from '../utils/erc721-seadrop-abi.js';
import {
  PublicDropSchema,
  MintStatsSchema,
  SignedMintValidationParamsSchema,
  type PublicDrop,
  type MintStats,
  type SeaDropMintScope,
  type SignedMintValidationParams,
} from '../types/seadrop.types.js';

/** Explicit budget per read: viem's own default retries several times and can run well past its nominal timeout. */
const SEADROP_READ_TIMEOUT_MS = 8_000;

/** Reads live SeaDrop state for an NFT contract (public stage, price, allow-list root), always fresh from the chain. */
export class SeaDropReader {
  constructor(private readonly client: PublicClient) {}

  async getPublicDrop(scope: SeaDropMintScope): Promise<PublicDrop> {
    const result = await withTimeout(
      this.client.readContract({
        address: SEADROP_ADDRESS,
        abi: SEADROP_ABI,
        functionName: 'getPublicDrop',
        args: [scope.nftContract as `0x${string}`],
      }),
      SEADROP_READ_TIMEOUT_MS,
      'getPublicDrop read',
    );

    return PublicDropSchema.parse({
      mintPrice: result.mintPrice,
      startTime: Number(result.startTime),
      endTime: Number(result.endTime),
      maxTotalMintableByWallet: Number(result.maxTotalMintableByWallet),
      feeBps: Number(result.feeBps),
      restrictFeeRecipients: result.restrictFeeRecipients,
    });
  }

  async getAllowListMerkleRoot(scope: SeaDropMintScope): Promise<`0x${string}`> {
    return withTimeout(
      this.client.readContract({
        address: SEADROP_ADDRESS,
        abi: SEADROP_ABI,
        functionName: 'getAllowListMerkleRoot',
        args: [scope.nftContract as `0x${string}`],
      }),
      SEADROP_READ_TIMEOUT_MS,
      'getAllowListMerkleRoot read',
    );
  }

  async getAllowedFeeRecipients(scope: SeaDropMintScope): Promise<readonly `0x${string}`[]> {
    return withTimeout(
      this.client.readContract({
        address: SEADROP_ADDRESS,
        abi: SEADROP_ABI,
        functionName: 'getAllowedFeeRecipients',
        args: [scope.nftContract as `0x${string}`],
      }),
      SEADROP_READ_TIMEOUT_MS,
      'getAllowedFeeRecipients read',
    );
  }

  /** The addresses allowed to sign `mintSigned` payloads for this contract. */
  async getSigners(scope: SeaDropMintScope): Promise<readonly `0x${string}`[]> {
    return withTimeout(
      this.client.readContract({
        address: SEADROP_ADDRESS,
        abi: SEADROP_ABI,
        functionName: 'getSigners',
        args: [scope.nftContract as `0x${string}`],
      }),
      SEADROP_READ_TIMEOUT_MS,
      'getSigners read',
    );
  }

  /** The bounds a signed mint from `signer` must satisfy: see SignedMintValidationParamsSchema. */
  async getSignedMintValidationParams(scope: SeaDropMintScope, signer: `0x${string}`): Promise<SignedMintValidationParams> {
    const result = await withTimeout(
      this.client.readContract({
        address: SEADROP_ADDRESS,
        abi: SEADROP_ABI,
        functionName: 'getSignedMintValidationParams',
        args: [scope.nftContract as `0x${string}`, signer],
      }),
      SEADROP_READ_TIMEOUT_MS,
      'getSignedMintValidationParams read',
    );

    return SignedMintValidationParamsSchema.parse({
      minMintPrice: result.minMintPrice,
      maxMaxTotalMintableByWallet: Number(result.maxMaxTotalMintableByWallet),
      minStartTime: Number(result.minStartTime),
      maxEndTime: Number(result.maxEndTime),
      maxMaxTokenSupplyForStage: Number(result.maxMaxTokenSupplyForStage),
      minFeeBps: Number(result.minFeeBps),
      maxFeeBps: Number(result.maxFeeBps),
    });
  }

  /**
   * How many a wallet has minted on this TOKEN (not stage-scoped: see erc721-seadrop-abi.ts), plus the
   * collection's current and max supply.
   */
  async getMintStats(scope: SeaDropMintScope, minter: `0x${string}`): Promise<MintStats> {
    const [minterNumMinted, currentTotalSupply, maxSupply] = await withTimeout(
      this.client.readContract({
        address: scope.nftContract as `0x${string}`,
        abi: ERC721_SEADROP_TOKEN_ABI,
        functionName: 'getMintStats',
        args: [minter],
      }),
      SEADROP_READ_TIMEOUT_MS,
      'getMintStats read',
    );

    return MintStatsSchema.parse({ minterNumMinted: Number(minterNumMinted), currentTotalSupply, maxSupply });
  }

  /** A drop with startTime 0 was never configured: inactive, not always open. */
  async isPublicStageActive(scope: SeaDropMintScope, nowUnixSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
    const drop = await this.getPublicDrop(scope);
    if (drop.startTime === 0) return false;
    return nowUnixSeconds >= drop.startTime && nowUnixSeconds <= drop.endTime;
  }
}
