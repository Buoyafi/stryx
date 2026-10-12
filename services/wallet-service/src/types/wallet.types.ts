import { z } from 'zod';

export const WalletTierSchema = z.enum(['TREASURY', 'HOT', 'MINT']);
export type WalletTier = z.infer<typeof WalletTierSchema>;

export const WalletStatusSchema = z.enum(['ACTIVE', 'ARCHIVED', 'COMPROMISED']);
export type WalletStatus = z.infer<typeof WalletStatusSchema>;

/** How Stryx came to hold the key, independent of `tier`. */
export const WalletOriginSchema = z.enum(['GENERATED', 'IMPORTED']);
export type WalletOrigin = z.infer<typeof WalletOriginSchema>;

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'address must be a 0x-prefixed 20-byte EVM address');

/** The full row as persisted: includes envelope-encrypted key material. */
export const WalletRecordSchema = z.object({
  id: z.string().min(1),
  address: AddressSchema,
  /** ADR-002 §3.2/§3.3: the sole owner. Never absent: every wallet has exactly one owning user. */
  userId: z.string().min(1),
  label: z.string().nullable(),
  tier: WalletTierSchema,
  status: WalletStatusSchema,
  origin: WalletOriginSchema,
  encryptedPrivateKey: z.string().min(1),
  wrappedDek: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  keyVersion: z.number().int().positive(),
  kmsKeyId: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type WalletRecord = z.infer<typeof WalletRecordSchema>;

/** Fields needed to insert a new wallet row. */
export type NewWalletData = Omit<WalletRecord, 'id' | 'createdAt' | 'updatedAt'>;

/** Key-material fields updated together on rotation. */
export type KeyMaterialUpdate = Pick<
  WalletRecord,
  'encryptedPrivateKey' | 'wrappedDek' | 'iv' | 'authTag' | 'keyVersion' | 'kmsKeyId'
>;

/** API-safe projection: everything EXCEPT key material. */
export type WalletSummary = Omit<
  WalletRecord,
  'encryptedPrivateKey' | 'wrappedDek' | 'iv' | 'authTag'
>;

export function toWalletSummary(record: WalletRecord): WalletSummary {
  const {
    encryptedPrivateKey: _encryptedPrivateKey,
    wrappedDek: _wrappedDek,
    iv: _iv,
    authTag: _authTag,
    ...summary
  } = record;
  return summary;
}
