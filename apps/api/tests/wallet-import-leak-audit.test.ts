import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generatePrivateKey } from 'viem/accounts';
import { WalletKeyService, LocalKeyManagementProvider } from '@stryx/key-management';
import { WalletService } from '@stryx/wallet-service';
import { buildApp } from '../src/app.js';
import { InMemoryWalletRepository } from './fakes/in-memory-wallet.repository.js';

/**
 * ADR-002 §3.1: a private key submitted for import must never persist outside the encrypted record.
 * These tests look for it in logs, errors and responses.
 */

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}

function makeCapturingLogger(): { calls: LogCall[]; debug: (msg: string, meta?: Record<string, unknown>) => void; info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void } {
  const calls: LogCall[] = [];
  const record = (level: LogCall['level']) => (msg: string, meta?: Record<string, unknown>) => {
    calls.push({ level, msg, ...(meta ? { meta } : {}) });
  };
  return { calls, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

/** Every logged msg+meta pair, flattened to one searchable string: catches the key however deeply nested it might be. */
function allLoggedText(logger: { calls: LogCall[] }): string {
  return logger.calls.map((c) => `${c.msg} ${JSON.stringify(c.meta ?? {})}`).join('\n');
}

function buildTestApp(): { app: FastifyInstance; logger: ReturnType<typeof makeCapturingLogger> } {
  const repository = new InMemoryWalletRepository();
  const kms = new LocalKeyManagementProvider();
  const walletKeyService = new WalletKeyService(kms);
  const walletService = new WalletService(repository, walletKeyService, kms.keyId);
  const logger = makeCapturingLogger();
  const app = buildApp({ walletService, logger });
  return { app, logger };
}

describe('wallet import: private key leak audit', () => {
  it('a successful import: the key never appears in any log call, and the response carries the derived address but never the key', async () => {
    const { app, logger } = buildTestApp();
    const privateKey = generatePrivateKey();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const res = await app.inject({ method: 'POST', url: '/wallets/import', payload: { privateKey, tier: 'HOT' } });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

    const loggedText = allLoggedText(logger);
    expect(loggedText).not.toContain(privateKey);
    expect(loggedText).not.toContain(privateKey.slice(2)); // bare hex, no 0x prefix
    expect(JSON.stringify(body)).not.toContain(privateKey);

    // Fastify's own request logger is separate from `deps.logger`, so it is captured too.
    const allWrites = [...stdout.mock.calls, ...stderr.mock.calls].map((c) => String(c[0])).join('\n');
    expect(allWrites).not.toContain(privateKey);
    expect(allWrites).not.toContain(privateKey.slice(2));

    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('an address-collision failure (409): the key never appears in the log or the response body', async () => {
    const { app, logger } = buildTestApp();
    const privateKey = generatePrivateKey();
    await app.inject({ method: 'POST', url: '/wallets/import', payload: { privateKey, tier: 'HOT' } });
    logger.calls.length = 0; // only the second (failing) attempt matters here

    const res = await app.inject({ method: 'POST', url: '/wallets/import', payload: { privateKey, tier: 'HOT' } });

    expect(res.statusCode).toBe(409);
    const loggedText = allLoggedText(logger);
    expect(loggedText).not.toContain(privateKey);
    expect(loggedText).not.toContain(privateKey.slice(2));
    expect(JSON.stringify(res.json())).not.toContain(privateKey);
    expect(JSON.stringify(res.json())).not.toContain(privateKey.slice(2));
  });

  it('a malformed-format key (fails schema validation, 400): the bad input never appears in the response body or a log call', async () => {
    const { app, logger } = buildTestApp();
    const badKey = '0xnothexatallnothexatallnothexatallnothexatallnothexatallnothex';

    const res = await app.inject({
      method: 'POST',
      url: '/wallets/import',
      payload: { privateKey: badKey, tier: 'HOT' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(JSON.stringify(res.json())).not.toContain(badKey);
    expect(allLoggedText(logger)).not.toContain(badKey);
  });

  it('an out-of-curve-range key (regex-valid hex, but not a real secp256k1 scalar), never leaks via the generic error handler (regression)', async () => {
    // viem's own error for an invalid key embeds the key's value: it must never reach a response or a
    // log.
    const { app, logger } = buildTestApp();
    const zeroKey = ('0x' + '00'.repeat(32)) as `0x${string}`;

    const res = await app.inject({
      method: 'POST',
      url: '/wallets/import',
      payload: { privateKey: zeroKey, tier: 'HOT' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a valid private key/i);

    const loggedText = allLoggedText(logger);
    expect(loggedText).not.toContain(zeroKey);
    // The specific decimal-encoded leak this bug produced (viem's message embeds the key's numeric
    // value, e.g. "got 0" for the all-zero case).
    expect(loggedText).not.toMatch(/got 0\b/);
    expect(loggedText).not.toContain('expected valid private key');
    expect(JSON.stringify(res.json())).not.toContain(zeroKey);
  });

  it('an out-of-curve-range key at the maximum end (curve order n) also never leaks its decimal value', async () => {
    const { app, logger } = buildTestApp();
    // secp256k1's order n: one past the largest valid private key.
    const tooLarge = '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141' as const;

    const res = await app.inject({
      method: 'POST',
      url: '/wallets/import',
      payload: { privateKey: tooLarge, tier: 'HOT' },
    });

    expect(res.statusCode).toBe(400);
    const loggedText = allLoggedText(logger);
    // viem's error would otherwise embed this exact decimal value.
    expect(loggedText).not.toContain('115792089237316195423570985008687907852837564279074904382605163141518161494337');
    expect(JSON.stringify(res.json())).not.toContain(
      '115792089237316195423570985008687907852837564279074904382605163141518161494337',
    );
  });

  describe('key-format normalisation (bare / whitespace-padded input) opens no new leak path', () => {
    /**
     * Runs one import and asserts the key, in any form the caller might have sent it, is absent from
     * every log call, stdout/stderr write, and the response body.
     */
    async function importAndAssertNoLeak(sent: string, secretHex: string, expectedStatus: number) {
      const { app, logger } = buildTestApp();
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const res = await app.inject({ method: 'POST', url: '/wallets/import', payload: { privateKey: sent, tier: 'HOT' } });

      const everything = [
        allLoggedText(logger),
        JSON.stringify(res.json()),
        ...[...stdout.mock.calls, ...stderr.mock.calls].map((c) => String(c[0])),
      ].join('\n');
      stdout.mockRestore();
      stderr.mockRestore();

      expect(res.statusCode).toBe(expectedStatus);
      expect(everything).not.toContain(secretHex); // bare hex is a substring of every prefixed/padded form too
      return res;
    }

    it('a BARE (no 0x) key imports, and never appears in logs, stdout/stderr or the response', async () => {
      const key = generatePrivateKey();
      const res = await importAndAssertNoLeak(key.slice(2), key.slice(2), 201);
      expect(res.json().address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('a whitespace-padded key (prefixed or bare) imports and never leaks', async () => {
      const key = generatePrivateKey();
      await importAndAssertNoLeak(`  ${key}\n`, key.slice(2), 201);
      await importAndAssertNoLeak(`\t${key.slice(2)}\r\n`, key.slice(2), 201);
    });

    it('a bare 64-char NON-hex string is rejected (400) without being echoed anywhere', async () => {
      const notHex = 'zq'.repeat(32);
      const res = await importAndAssertNoLeak(notHex, notHex, 400);
      expect(res.json().error).toBe('validation_error');
    });

    it('a bare CURVE-INVALID key (64 zeros: passes the format check once normalised) gets the clean 400, with neither the key nor viem\'s decimal-embedding message leaking', async () => {
      const zeros = '00'.repeat(32);
      const { app, logger } = buildTestApp();

      const res = await app.inject({ method: 'POST', url: '/wallets/import', payload: { privateKey: zeros, tier: 'HOT' } });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not a valid private key/i);
      const logged = allLoggedText(logger);
      expect(logged).not.toContain(zeros);
      expect(logged).not.toMatch(/got 0\b/);
      expect(logged).not.toContain('expected valid private key');
    });
  });
});
