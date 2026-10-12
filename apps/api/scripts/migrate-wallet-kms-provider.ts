#!/usr/bin/env -S npx tsx
/**
 * Moves existing wallets from one KMS provider to another (ADR-002 §3.9), for example off
 * LOCAL_KMS_KEK onto AWS KMS. Changing KMS_PROVIDER alone migrates nothing: each wallet's data key
 * stays wrapped by the provider that made it, and signing fails until this has run. Every wallet is
 * re-wrapped in its own transaction and then verified by decrypting it through the target provider; a
 * wallet that fails verification is restored and the run halts.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '@stryx/config';
import { createLogger } from '@stryx/logger';
import { getPrismaClient, disconnectPrisma, type Prisma } from '@stryx/database';
import {
  WalletKeyService,
  LocalKeyManagementProvider,
  AwsKeyManagementProvider,
  EncryptedPrivateKeyRecordSchema,
  type EncryptedPrivateKeyRecord,
  type KeyManagementProvider,
  type Logger as KeyManagementLogger,
} from '@stryx/key-management';

interface CliOptions {
  commit: boolean;
  limit?: number;
  walletIds?: string[];
  sourceKeyId: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { commit: false, sourceKeyId: 'local-dev-kek' };
  for (const arg of argv) {
    if (arg === '--commit') options.commit = true;
    else if (arg.startsWith('--limit=')) {
      // A non-numeric, zero or negative limit is refused: read as "no limit" it would migrate the
      // whole table.
      const raw = arg.slice('--limit='.length);
      const limit = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1) throw new Error(`--limit must be a whole number above zero, got "${raw}"`);
      options.limit = limit;
    }
    else if (arg.startsWith('--wallet-id=')) options.walletIds = arg.slice('--wallet-id='.length).split(',');
    else if (arg.startsWith('--source-kms-key-id=')) options.sourceKeyId = arg.slice('--source-kms-key-id='.length);
    else if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console -- CLI usage text belongs on stdout
      console.log(
        'Usage: migrate-wallet-kms-provider.ts [--commit] [--limit=N] [--wallet-id=<id>[,<id>...]] [--source-kms-key-id=<id>]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger({ service: 'migrate-wallet-kms-provider', pretty: true });

  if (!config.KMS_KEY_ID) {
    throw new Error('KMS_KEY_ID is not set, needed to build the target AWS KMS provider regardless of KMS_PROVIDER.');
  }

  const sourceKms = new LocalKeyManagementProvider();
  const targetKms = new AwsKeyManagementProvider(
    new KMSClient({}),
    {
      encryptCommand: (kid, plaintext) => new EncryptCommand({ KeyId: kid, Plaintext: plaintext }),
      decryptCommand: (kid, ciphertext) => new DecryptCommand({ KeyId: kid, CiphertextBlob: ciphertext }),
    },
    config.KMS_KEY_ID,
  );
  const walletKeyService = new WalletKeyService(sourceKms, logger);

  logger.info('verifying target KMS provider is actually reachable before touching any wallet', {
    targetKeyId: targetKms.keyId,
  });
  try {
    const probe = randomBytes(32);
    const wrapped = await targetKms.wrapDek(probe);
    const unwrapped = await targetKms.unwrapDek(wrapped);
    if (!unwrapped.equals(probe)) {
      throw new Error('round-trip mismatch: target KMS returned different bytes than were wrapped');
    }
  } catch (err) {
    logger.error('target KMS provider failed a pre-flight round-trip, aborting before touching any wallet', {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
    return;
  }
  logger.info('target KMS provider verified reachable and correct');

  // DATABASE_URL (the migration-owning role), not RUNTIME_DATABASE_URL.
  const prisma = getPrismaClient(config.DATABASE_URL);

  const wallets = await prisma.wallet.findMany({
    where: {
      kmsKeyId: options.sourceKeyId,
      ...(options.walletIds ? { id: { in: options.walletIds } } : {}),
    },
    ...(options.limit ? { take: options.limit } : {}),
  });

  if (wallets.length === 0) {
    logger.info('no wallets match: nothing to migrate', { sourceKeyId: options.sourceKeyId });
    await disconnectPrisma();
    return;
  }

  logger.info(`found ${wallets.length} wallet(s) to ${options.commit ? 'migrate' : 'dry-run'}`, {
    sourceKeyId: options.sourceKeyId,
    targetKeyId: targetKms.keyId,
    commit: options.commit,
  });

  const migrated: string[] = [];
  const failed: string[] = [];
  const conflicts: string[] = [];
  const criticalFailures: string[] = [];

  walletLoop: for (const wallet of wallets) {
    const record: EncryptedPrivateKeyRecord = EncryptedPrivateKeyRecordSchema.parse({
      encryptedPrivateKey: wallet.encryptedPrivateKey,
      wrappedDek: wallet.wrappedDek,
      iv: wallet.iv,
      authTag: wallet.authTag,
      keyVersion: wallet.keyVersion,
    });

    let newRecord: EncryptedPrivateKeyRecord;
    try {
      newRecord = await walletKeyService.migrateToProvider({ walletId: wallet.id }, record, targetKms);
    } catch (err) {
      // Per-wallet isolation: log and move on.
      logger.error('failed to migrate wallet, skipped, wallet is UNTOUCHED, continuing with the rest', {
        walletId: wallet.id,
        address: wallet.address,
        message: err instanceof Error ? err.message : String(err),
      });
      failed.push(wallet.id);
      continue;
    }

    if (!options.commit) {
      logger.info(`[dry-run] would migrate wallet ${wallet.id} (${wallet.address})`, {
        fromVersion: record.keyVersion,
        toVersion: newRecord.keyVersion,
      });
      migrated.push(wallet.id);
      continue;
    }

    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Optimistic concurrency: only apply if the wallet is still exactly as we read it.
        const result = await tx.wallet.updateMany({
          where: { id: wallet.id, keyVersion: wallet.keyVersion },
          data: {
            encryptedPrivateKey: newRecord.encryptedPrivateKey,
            wrappedDek: newRecord.wrappedDek,
            iv: newRecord.iv,
            authTag: newRecord.authTag,
            keyVersion: newRecord.keyVersion,
            kmsKeyId: targetKms.keyId,
          },
        });
        if (result.count === 0) {
          throw new Error('CONCURRENT_MODIFICATION');
        }
        await tx.walletKeyRotationEvent.create({
          data: {
            walletId: wallet.id,
            fromVersion: record.keyVersion,
            toVersion: newRecord.keyVersion,
            kmsKeyId: targetKms.keyId,
            reason: 'kms_provider_migration',
          },
        });
        return true;
      });
    } catch (err) {
      // Nothing was committed: the transaction rolled back.
      if (err instanceof Error && err.message === 'CONCURRENT_MODIFICATION') {
        logger.warn('wallet changed since it was read, skipped to avoid overwriting a concurrent change', {
          walletId: wallet.id,
        });
        conflicts.push(wallet.id);
      } else {
        logger.error('DB write failed after a successful crypto migration: wallet left on the OLD provider', {
          walletId: wallet.id,
          message: err instanceof Error ? err.message : String(err),
        });
        failed.push(wallet.id);
      }
      continue;
    }

    try {
      logger.info(`committed wallet ${wallet.id} (${wallet.address}), verifying before counting as migrated`, {
        fromVersion: record.keyVersion,
        toVersion: newRecord.keyVersion,
      });

      // Verify after the commit.
      const persisted = await prisma.wallet.findUnique({ where: { id: wallet.id } });
      const verification = persisted
        ? await verifyMigratedWallet(persisted, targetKms, logger)
        : { ok: false as const, reason: 'wallet row disappeared after commit (unexpected)' };

      if (verification.ok) {
        logger.info(`verified wallet ${wallet.id}: decrypts correctly via the target provider and derives the correct address`, {
          walletId: wallet.id,
        });
        migrated.push(wallet.id);
        continue;
      }

      // Committed, but unusable or wrong.
      logger.error(
        'CRITICAL: wallet committed to the new provider but FAILED post-commit verification: ' +
          'attempting to revert it to its original state now',
        { walletId: wallet.id, address: wallet.address, reason: verification.reason },
      );

      const reverted = await revertWallet(prisma, wallet.id, record, newRecord.keyVersion, sourceKms.keyId);
      if (reverted) {
        logger.error(
          'CRITICAL: reverted the wallet back to its original (source-provider) key material. ' +
            'It is once again usable, but this migration attempt did NOT succeed. STOPPING: ' +
            'investigate the target KMS/environment before retrying any further wallets.',
          { walletId: wallet.id },
        );
      } else {
        logger.error(
          'CRITICAL: automatic revert ALSO FAILED. This wallet may be left in the post-migration, ' +
            'failed-verification state. DO NOT assume it is usable in either direction: ' +
            'inspect it manually before doing anything else. STOPPING.',
          { walletId: wallet.id },
        );
      }

      criticalFailures.push(wallet.id);
      // A verification failure after commit may be systemic: halt.
      break walletLoop;
    } catch (err) {
      // The commit went through and something after it threw (the re-read, the check, the revert).
      logger.error(
        'CRITICAL: wallet was COMMITTED to the new provider, but the check after the commit could not finish. ' +
          'It is NOT confirmed usable and was NOT reverted: inspect it by hand before doing anything else. STOPPING.',
        { walletId: wallet.id, address: wallet.address, message: err instanceof Error ? err.message : String(err) },
      );
      criticalFailures.push(wallet.id);
      break walletLoop;
    }
  }

  logger.info('done', {
    mode: options.commit ? 'commit' : 'dry-run',
    migrated: migrated.length,
    failed: failed.length,
    conflicts: conflicts.length,
    criticalFailures: criticalFailures.length,
    failedWalletIds: failed,
    conflictWalletIds: conflicts,
    criticalFailureWalletIds: criticalFailures,
  });
  if (criticalFailures.length > 0) {
    logger.error(
      'This run STOPPED EARLY due to a post-commit verification failure: wallets after the ' +
        'failure point were never attempted. See the CRITICAL log lines above for what to check ' +
        'before re-running.',
    );
  }

  await disconnectPrisma();
  process.exitCode = failed.length > 0 || conflicts.length > 0 || criticalFailures.length > 0 ? 1 : 0;
}

/**
 * Decrypts a just-committed wallet row through the target provider and confirms the recovered key
 * derives this wallet's address, not just that decryption did not throw.
 */
export interface PersistedWalletKeyFields {
  id: string;
  address: string;
  encryptedPrivateKey: string;
  wrappedDek: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export async function verifyMigratedWallet(
  persistedWallet: PersistedWalletKeyFields,
  targetKms: Pick<KeyManagementProvider, 'wrapDek' | 'unwrapDek' | 'keyId'>,
  logger?: KeyManagementLogger,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verifyingService = new WalletKeyService(targetKms, logger);
  const persistedRecord = EncryptedPrivateKeyRecordSchema.parse({
    encryptedPrivateKey: persistedWallet.encryptedPrivateKey,
    wrappedDek: persistedWallet.wrappedDek,
    iv: persistedWallet.iv,
    authTag: persistedWallet.authTag,
    keyVersion: persistedWallet.keyVersion,
  });

  try {
    const derivedAddress = await verifyingService.withDecryptedPrivateKey(
      { walletId: persistedWallet.id },
      persistedRecord,
      (privateKey) => privateKeyToAccount(`0x${privateKey.toString('hex')}` as `0x${string}`).address.toLowerCase(),
    );
    if (derivedAddress !== persistedWallet.address.toLowerCase()) {
      return {
        ok: false,
        reason: `decrypted successfully but derived address ${derivedAddress} does not match the wallet's recorded address ${persistedWallet.address}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Best-effort restore of a wallet's previous key material after a failed verification, only while the
 * row is still exactly what the migration wrote.
 */
export interface RevertCapablePrismaClient {
  $transaction<T>(fn: (tx: RevertTransactionClient) => Promise<T>): Promise<T>;
}
export interface RevertTransactionClient {
  wallet: {
    updateMany(args: {
      where: { id: string; keyVersion: number };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  walletKeyRotationEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export async function revertWallet(
  prisma: RevertCapablePrismaClient,
  walletId: string,
  original: EncryptedPrivateKeyRecord,
  currentKeyVersion: number,
  sourceKmsKeyId: string,
): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await tx.wallet.updateMany({
        where: { id: walletId, keyVersion: currentKeyVersion },
        data: {
          encryptedPrivateKey: original.encryptedPrivateKey,
          wrappedDek: original.wrappedDek,
          iv: original.iv,
          authTag: original.authTag,
          keyVersion: original.keyVersion,
          kmsKeyId: sourceKmsKeyId,
        },
      });
      if (result.count === 0) return false;
      await tx.walletKeyRotationEvent.create({
        data: {
          walletId,
          fromVersion: currentKeyVersion,
          toVersion: original.keyVersion,
          kmsKeyId: sourceKmsKeyId,
          reason: 'kms_provider_migration_reverted_after_failed_verification',
        },
      });
      return true;
    });
  } catch {
    return false;
  }
}

// Run main() only when this file is the process entry point, never on import.
import { fileURLToPath } from 'node:url';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error('Fatal error running migration script', err);
    process.exitCode = 1;
  });
}
