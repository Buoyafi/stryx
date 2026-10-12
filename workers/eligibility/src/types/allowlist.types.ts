import { z } from 'zod';
import { MintParamsSchema } from '@stryx/nft-engine';

/** One row of a SeaDrop allow list: a wallet, and the exact MintParams it's entitled to use. */
export const AllowListEntrySchema = z.object({
  minter: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  mintParams: MintParamsSchema,
});
export type AllowListEntry = z.infer<typeof AllowListEntrySchema>;

export const EligibilityResultSchema = z.discriminatedUnion('eligible', [
  z.object({
    eligible: z.literal(true),
    mintParams: MintParamsSchema,
    proof: z.array(z.string()),
  }),
  z.object({
    eligible: z.literal(false),
    reason: z.enum(['not_on_list', 'root_mismatch', 'proof_failed_local_verification']),
  }),
]);
export type EligibilityResult = z.infer<typeof EligibilityResultSchema>;
