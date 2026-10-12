import { describe, expect, it } from 'vitest';
import { WalletRecordSchema } from '../src/types/wallet.types.js';

const validRow = {
  id: 'w1',
  address: '0x' + 'ab'.repeat(20),
  userId: 'u1',
  label: null,
  tier: 'HOT',
  status: 'ACTIVE',
  origin: 'GENERATED',
  encryptedPrivateKey: 'x',
  wrappedDek: 'x',
  iv: 'x',
  authTag: 'x',
  keyVersion: 1,
  kmsKeyId: 'k',
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** PrismaWalletRepository parses every row it reads through this schema. */
describe('WalletRecordSchema.origin', () => {
  it('accepts both origins', () => {
    expect(WalletRecordSchema.safeParse({ ...validRow, origin: 'GENERATED' }).success).toBe(true);
    expect(WalletRecordSchema.safeParse({ ...validRow, origin: 'IMPORTED' }).success).toBe(true);
  });

  it('rejects a row with no origin, rather than defaulting it', () => {
    const { origin: _origin, ...withoutOrigin } = validRow;
    expect(WalletRecordSchema.safeParse(withoutOrigin).success).toBe(false);
  });

  it.each(['generated', 'TREASURY', '', null])('rejects an invalid origin value %j', (bad) => {
    expect(WalletRecordSchema.safeParse({ ...validRow, origin: bad }).success).toBe(false);
  });
});
