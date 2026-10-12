import { z } from 'zod';

/** Mirrors SeaDrop's on-chain `PublicDrop` struct exactly (source: ProjectOpenSea/seadrop, src/lib/SeaDropStructs.sol). */
export const PublicDropSchema = z.object({
  mintPrice: z.bigint(), // wei, per token
  startTime: z.number().int().nonnegative(), // unix seconds
  endTime: z.number().int().nonnegative(),
  maxTotalMintableByWallet: z.number().int().nonnegative(),
  feeBps: z.number().int().nonnegative(),
  restrictFeeRecipients: z.boolean(),
});
export type PublicDrop = z.infer<typeof PublicDropSchema>;

/** Mirrors SeaDrop's on-chain `MintParams` struct, used for allow-list (presale/FCFS) stages. */
export const MintParamsSchema = z.object({
  mintPrice: z.bigint(),
  maxTotalMintableByWallet: z.number().int().nonnegative(),
  startTime: z.number().int().nonnegative(),
  endTime: z.number().int().nonnegative(),
  dropStageIndex: z.number().int().nonnegative(), // 1 = first presale stage, up to 5 presale stages supported
  maxTokenSupplyForStage: z.bigint(),
  feeBps: z.number().int().nonnegative(),
  restrictFeeRecipients: z.boolean(),
});
export type MintParams = z.infer<typeof MintParamsSchema>;

export const SeaDropMintScopeSchema = z.object({
  nftContract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().positive(),
});
export type SeaDropMintScope = z.infer<typeof SeaDropMintScopeSchema>;

/** `getMintStats`'s return tuple, read from the token contract (see erc721-seadrop-abi.ts). */
export const MintStatsSchema = z.object({
  minterNumMinted: z.number().int().nonnegative(),
  currentTotalSupply: z.bigint(),
  maxSupply: z.bigint(),
});
export type MintStats = z.infer<typeof MintStatsSchema>;

/**
 * Mirrors SeaDrop's on-chain `SignedMintValidationParams` struct (SeaDropStructs.sol), read per
 * (nftContract, signer) via `getSignedMintValidationParams`.
 */
export const SignedMintValidationParamsSchema = z.object({
  minMintPrice: z.bigint(),
  maxMaxTotalMintableByWallet: z.number().int().nonnegative(),
  minStartTime: z.number().int().nonnegative(),
  maxEndTime: z.number().int().nonnegative(),
  maxMaxTokenSupplyForStage: z.number().int().nonnegative(),
  minFeeBps: z.number().int().nonnegative(),
  maxFeeBps: z.number().int().nonnegative(),
});
export type SignedMintValidationParams = z.infer<typeof SignedMintValidationParamsSchema>;
