import { z } from 'zod';
import { normalizePrivateKeyInput, PRIVATE_KEY_PATTERN } from '@stryx/utils/private-key';
import { WalletTierSchema } from '../types/wallet.types.js';

export const CreateWalletInputSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  tier: WalletTierSchema.optional().default('HOT'),
});
export type CreateWalletInput = z.infer<typeof CreateWalletInputSchema>;

// The prefix is capped shorter than a label so the "-01".."-99" suffix always fits.
export const BulkCreateWalletInputSchema = z.object({
  count: z.number().int().min(1).max(100),
  labelPrefix: z.string().min(1).max(190).optional(),
  tier: WalletTierSchema.optional().default('HOT'),
});
export type BulkCreateWalletInput = z.infer<typeof BulkCreateWalletInputSchema>;

export const ImportWalletInputSchema = z.object({
  // Normalise, then validate, with the same module the dashboard uses, so both sides agree on the
  // format.
  privateKey: z
    .string()
    .transform(normalizePrivateKeyInput)
    .pipe(z.string().regex(PRIVATE_KEY_PATTERN, 'privateKey must be 32 bytes of hex (64 characters), with or without a 0x prefix')),
  label: z.string().min(1).max(200).optional(),
  tier: WalletTierSchema.optional().default('HOT'),
});
export type ImportWalletInput = z.infer<typeof ImportWalletInputSchema>;

export const WalletIdParamSchema = z.object({
  id: z.string().min(1),
});

export const ListWalletsQuerySchema = z.object({
  tier: WalletTierSchema.optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'COMPROMISED']).optional(),
});

export const RenameWalletInputSchema = z.object({
  // null clears the label; a string sets it.
  label: z.string().min(1).max(60).nullable(),
});
