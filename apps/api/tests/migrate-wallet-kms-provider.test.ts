import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletKeyService } from '@stryx/key-management';
import {
  verifyMigratedWallet,
  revertWallet,
  type PersistedWalletKeyFields,
  type RevertCapablePrismaClient,
  type RevertTransactionClient,
  parseArgs,
} from '../scripts/migrate-wallet-kms-provider.js';

/**
 * The migration script's own logic beyond WalletKeyService.migrateToProvider: verifying a committed
 * row, and restoring it when verification fails.
 */

// A fake KeyManagementProvider that wraps with its own in-memory key, so a real wrap and unwrap round
// trip is tested.
function makeFakeKms(keyId = 'fake-target-kms') {
  const kek = randomBytes(32);
  return {
    keyId,
    async wrapDek(dek: Buffer): Promise<Buffer> {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', kek, iv);
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    async unwrapDek(wrappedDek: Buffer): Promise<Buffer> {
      const iv = wrappedDek.subarray(0, 12);
      const authTag = wrappedDek.subarray(12, 28);
      const ciphertext = wrappedDek.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', kek, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    },
  };
}

async function buildPersistedWallet(): Promise<{ fields: PersistedWalletKeyFields; address: string }> {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address.toLowerCase();
  const targetKms = makeFakeKms();
  const service = new WalletKeyService(targetKms);
  const record = await service.encryptPrivateKeyForStorage(
    { walletId: 'wallet-1' },
    Buffer.from(privateKey.slice(2), 'hex'),
  );
  return {
    fields: { id: 'wallet-1', address, ...record },
    address,
  };
}

describe('verifyMigratedWallet', () => {
  it('returns ok:true when the wallet genuinely decrypts via the target provider and derives its own address', async () => {
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address.toLowerCase();
    const targetKms = makeFakeKms();
    const service = new WalletKeyService(targetKms);
    const record = await service.encryptPrivateKeyForStorage(
      { walletId: 'wallet-1' },
      Buffer.from(privateKey.slice(2), 'hex'),
    );

    const result = await verifyMigratedWallet({ id: 'wallet-1', address, ...record }, targetKms);

    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false when decryption succeeds but derives a DIFFERENT address than recorded (the corruption case this exists to catch)', async () => {
    const { fields } = await buildPersistedWallet();
    const targetKms = makeFakeKms();
    // A different private key under the same target provider, with the original wallet's address:
    // decryption succeeds but yields the wrong key.
    const otherPrivateKey = generatePrivateKey();
    const service = new WalletKeyService(targetKms);
    const wrongRecord = await service.encryptPrivateKeyForStorage(
      { walletId: 'wallet-1' },
      Buffer.from(otherPrivateKey.slice(2), 'hex'),
    );

    const result = await verifyMigratedWallet({ ...fields, ...wrongRecord }, targetKms);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/does not match the wallet's recorded address/);
    }
  });

  it('returns ok:false (not a throw) when decryption itself fails against the target provider', async () => {
    const { fields } = await buildPersistedWallet();
    // A provider that can never unwrap what was wrapped elsewhere.
    const wrongTargetKms = makeFakeKms('a-completely-different-kms');

    const result = await verifyMigratedWallet(fields, wrongTargetKms);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBeTruthy();
    }
  });

  it('never throws out of the function itself: always returns a result object', async () => {
    const { fields } = await buildPersistedWallet();
    const throwingKms = {
      keyId: 'throwing-kms',
      async wrapDek(): Promise<Buffer> {
        throw new Error('should not be called by verification');
      },
      async unwrapDek(): Promise<Buffer> {
        throw new Error('simulated KMS outage during verification');
      },
    };

    await expect(verifyMigratedWallet(fields, throwingKms)).resolves.toMatchObject({ ok: false });
  });
});

describe('revertWallet', () => {
  function makeFakePrisma(initialKeyVersion: number) {
    const state = {
      wallet: { keyVersion: initialKeyVersion, encryptedPrivateKey: 'new', wrappedDek: 'new', iv: 'new', authTag: 'new', kmsKeyId: 'target-kms' },
      rotationEvents: [] as unknown[],
    };
    const tx: RevertTransactionClient = {
      wallet: {
        async updateMany(args) {
          if (args.where.keyVersion !== state.wallet.keyVersion) return { count: 0 };
          Object.assign(state.wallet, args.data);
          return { count: 1 };
        },
      },
      walletKeyRotationEvent: {
        async create(args) {
          state.rotationEvents.push(args.data);
          return args.data;
        },
      },
    };
    const prisma: RevertCapablePrismaClient = {
      async $transaction(fn) {
        return fn(tx);
      },
    };
    return { prisma, state };
  }

  const original = {
    encryptedPrivateKey: 'original-ciphertext',
    wrappedDek: 'original-wrapped-dek',
    iv: 'original-iv',
    authTag: 'original-auth-tag',
    keyVersion: 1,
  };

  it('restores the original key material and records a revert rotation event, when the wallet is still at the expected version', async () => {
    const { prisma, state } = makeFakePrisma(2); // currently at v2, the post-migration version

    const result = await revertWallet(prisma, 'wallet-1', original, 2, 'source-kms');

    expect(result).toBe(true);
    expect(state.wallet).toMatchObject({
      encryptedPrivateKey: 'original-ciphertext',
      wrappedDek: 'original-wrapped-dek',
      iv: 'original-iv',
      authTag: 'original-auth-tag',
      keyVersion: 1,
      kmsKeyId: 'source-kms',
    });
    expect(state.rotationEvents).toEqual([
      {
        walletId: 'wallet-1',
        fromVersion: 2,
        toVersion: 1,
        kmsKeyId: 'source-kms',
        reason: 'kms_provider_migration_reverted_after_failed_verification',
      },
    ]);
  });

  it('returns false (does not throw, does not claim success) when the wallet has already moved to a different version since', async () => {
    // A concurrent change between the failed verification and the revert: the revert must refuse.
    const { prisma, state } = makeFakePrisma(3); // NOT the version we expect (2)

    const result = await revertWallet(prisma, 'wallet-1', original, 2, 'source-kms');

    expect(result).toBe(false);
    // Nothing was touched.
    expect(state.wallet.keyVersion).toBe(3);
    expect(state.rotationEvents).toEqual([]);
  });

  it('returns false when the transaction itself throws, rather than propagating', async () => {
    const throwingPrisma: RevertCapablePrismaClient = {
      async $transaction() {
        throw new Error('simulated DB outage during revert');
      },
    };

    await expect(revertWallet(throwingPrisma, 'wallet-1', original, 2, 'source-kms')).resolves.toBe(false);
  });
});

describe('parseArgs: --limit', () => {
  it('takes a whole number above zero', () => {
    expect(parseArgs(['--limit=5']).limit).toBe(5);
    expect(parseArgs(['--commit', '--limit=120'])).toMatchObject({ commit: true, limit: 120 });
    expect(parseArgs([]).limit).toBeUndefined();
  });

  it('refuses anything else, instead of quietly meaning "every wallet"', () => {
    for (const bad of ['abc', '', '0', '-3', '2.5', '5x', ' 5', '1e3', 'NaN', 'Infinity']) {
      expect(() => parseArgs([`--limit=${bad}`]), bad).toThrow(/--limit must be a whole number above zero/);
    }
  });
});
