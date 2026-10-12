import { describe, expect, it, afterEach } from 'vitest';
import { LocalKeyManagementProvider } from '../src/local-key-management-provider.js';
import { LocalKmsUsedInProductionError } from '../src/errors.js';

/**
 * ADR-002 §3.8: like AwsKeyManagementProvider, this class had zero direct test coverage (it's only
 * exercised indirectly via other tests' setup).
 */

const VALID_KEK = '00'.repeat(32); // 32 bytes hex

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('LocalKeyManagementProvider', () => {
  afterEach(() => {
    delete process.env['NODE_ENV'];
    delete process.env['LOCAL_KMS_KEK'];
  });

  it('refuses to construct when NODE_ENV=production: the hard guard rail this class exists to have', async () => {
    await withEnv({ NODE_ENV: 'production', LOCAL_KMS_KEK: VALID_KEK }, () => {
      expect(() => new LocalKeyManagementProvider()).toThrow(LocalKmsUsedInProductionError);
    });
  });

  it('refuses to construct without LOCAL_KMS_KEK set', async () => {
    await withEnv({ NODE_ENV: 'development', LOCAL_KMS_KEK: undefined }, () => {
      expect(() => new LocalKeyManagementProvider()).toThrow(/LOCAL_KMS_KEK is not set/);
    });
  });

  it('refuses a LOCAL_KMS_KEK that is not exactly 32 bytes', async () => {
    await withEnv({ NODE_ENV: 'development', LOCAL_KMS_KEK: 'deadbeef' }, () => {
      expect(() => new LocalKeyManagementProvider()).toThrow(/must be exactly 32 bytes/);
    });
  });

  it('wraps and unwraps a DEK correctly given a valid key', async () => {
    await withEnv({ NODE_ENV: 'development', LOCAL_KMS_KEK: VALID_KEK }, async () => {
      const provider = new LocalKeyManagementProvider();
      const dek = Buffer.from('a-32-byte-dek-worth-of-bytes!!!!');

      const wrapped = await provider.wrapDek(dek);
      const unwrapped = await provider.unwrapDek(wrapped);

      expect(unwrapped.equals(dek)).toBe(true);
    });
  });

  it('is stable across instances given the same LOCAL_KMS_KEK: a DEK wrapped by one instance unwraps in another', async () => {
    // A restart must not orphan wallets that were already encrypted.
    await withEnv({ NODE_ENV: 'development', LOCAL_KMS_KEK: VALID_KEK }, async () => {
      const providerA = new LocalKeyManagementProvider();
      const providerB = new LocalKeyManagementProvider();
      const dek = Buffer.from('cross-instance-dek-bytes-here!!!');

      const wrapped = await providerA.wrapDek(dek);
      const unwrapped = await providerB.unwrapDek(wrapped);

      expect(unwrapped.equals(dek)).toBe(true);
    });
  });

  it('fails to unwrap a DEK wrapped under a different LOCAL_KMS_KEK (auth tag mismatch)', async () => {
    const wrapped = await withEnv({ NODE_ENV: 'development', LOCAL_KMS_KEK: VALID_KEK }, () => {
      const provider = new LocalKeyManagementProvider();
      return provider.wrapDek(Buffer.from('some-dek-bytes-thirty-two-long!!'));
    });

    await withEnv({ NODE_ENV: 'development', LOCAL_KMS_KEK: 'ff'.repeat(32) }, async () => {
      const differentKeyProvider = new LocalKeyManagementProvider();
      await expect(differentKeyProvider.unwrapDek(wrapped)).rejects.toThrow();
    });
  });
});
