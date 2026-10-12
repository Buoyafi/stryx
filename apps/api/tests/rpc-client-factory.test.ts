import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainPublicClient, createRaceBroadcaster, firstToSucceed } from '../src/rpc-client-factory.js';
import type { AppConfig } from '@stryx/config';

const baseConfig = { RPC_ROBINHOOD_TESTNET: 'https://rpc.testnet.example.com' } as unknown as AppConfig;

function fakeLogger() {
  const calls: { level: string; msg: string; meta?: Record<string, unknown> }[] = [];
  const push = (level: string, msg: string, meta?: Record<string, unknown>) => calls.push(meta ? { level, msg, meta } : { level, msg });
  const logger = {
    debug: (msg: string, meta?: Record<string, unknown>) => push('debug', msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => push('info', msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => push('warn', msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => push('error', msg, meta),
  };
  return { logger, calls };
}

describe('createChainPublicClient', () => {
  it('throws a clear error for a chain with no RPC configured', () => {
    expect(() => createChainPublicClient(baseConfig, 999_999)).toThrow(/No RPC URL configured/);
  });

  it('tunes the transport to a tighter, more predictable bound than viem\'s own defaults: 2 attempts (retryCount 1), 5s each, not 3 retries at 10s (~40s worst case)', () => {
    const client = createChainPublicClient(baseConfig, 46630);
    const transport = client.transport as unknown as { type: string; timeout: number; retryCount: number; retryDelay: number };
    expect(transport.type).toBe('http');
    expect(transport.timeout).toBe(5_000);
    expect(transport.retryCount).toBe(1);
    expect(transport.retryDelay).toBe(300);
  });

  it('with only a primary configured, unaffected by the fallback feature: still a plain single http transport', () => {
    const client = createChainPublicClient({ RPC_ROBINHOOD_PRIMARY: 'https://primary.example.com' } as unknown as AppConfig, 4663);
    expect((client.transport as unknown as { type: string }).type).toBe('http');
  });

  it('a fallback-only chain (primary unset) keeps working, using the fallback as its sole endpoint, logging a warning', () => {
    const { logger, calls } = fakeLogger();
    const client = createChainPublicClient({ RPC_ROBINHOOD_FALLBACK: 'https://fallback.example.com' } as unknown as AppConfig, 4663, logger);
    expect((client.transport as unknown as { type: string }).type).toBe('http');
    expect(calls.some((c) => c.level === 'warn' && /fallback-only/.test(c.msg))).toBe(true);
  });

  it('with both configured, builds a real fallback transport over both endpoints, retrying the whole pass once', () => {
    const client = createChainPublicClient({ RPC_ROBINHOOD_PRIMARY: 'https://primary.example.com', RPC_ROBINHOOD_FALLBACK: 'https://fallback.example.com' } as unknown as AppConfig, 4663);
    const transport = client.transport as unknown as { type: string; retryCount: number; retryDelay: number };
    expect(transport.type).toBe('fallback');
    expect(transport.retryCount).toBe(1);
    expect(transport.retryDelay).toBe(300);
  });

  describe('real fallback behavior, over a mocked global fetch', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('falls back to the second endpoint on a transport failure from the primary, and a real read succeeds through it', async () => {
      const primaryUrl = 'https://primary.example.com';
      const fallbackUrl = 'https://fallback.example.com';
      const calls: string[] = [];

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          calls.push(url);
          // viem normalizes a URL with no path to add a trailing slash before it ever reaches fetch:
          // startsWith, not ===, so that normalization doesn't break this.
          if (url.startsWith(primaryUrl)) throw new TypeError('fetch failed');
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }),
      );

      const client = createChainPublicClient({ RPC_ROBINHOOD_PRIMARY: primaryUrl, RPC_ROBINHOOD_FALLBACK: fallbackUrl } as unknown as AppConfig, 4663);
      const chainId = await client.getChainId();

      expect(chainId).toBe(1);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('primary.example.com');
      expect(calls[1]).toContain('fallback.example.com');
    });

    it('never falls back for a non-transport error (a real JSON-RPC error response): retrying an identical bad request wastes a round trip for nothing', async () => {
      const primaryUrl = 'https://primary.example.com';
      const fallbackUrl = 'https://fallback.example.com';
      const calls: string[] = [];

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          calls.push(url);
          // A well-formed JSON-RPC error response (e.g. invalid params): not a transport failure, so
          // this must never trigger a fallback attempt.
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }),
      );

      const client = createChainPublicClient({ RPC_ROBINHOOD_PRIMARY: primaryUrl, RPC_ROBINHOOD_FALLBACK: fallbackUrl } as unknown as AppConfig, 4663);
      await expect(client.getChainId()).rejects.toThrow();
      expect(calls).toHaveLength(1); // never touched the fallback
      expect(calls[0]).toContain('primary.example.com');
    });

    it('logs which endpoint actually served a request, without ever including its URL in the log line', async () => {
      const primaryUrl = 'https://primary.example.com';
      const fallbackUrl = 'https://fallback.example.com';
      const { logger, calls } = fakeLogger();

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200, headers: { 'content-type': 'application/json' } })),
      );

      const client = createChainPublicClient({ RPC_ROBINHOOD_PRIMARY: primaryUrl, RPC_ROBINHOOD_FALLBACK: fallbackUrl } as unknown as AppConfig, 4663, logger);
      await client.getChainId();

      const served = calls.find((c) => c.level === 'debug' && c.msg === 'chain RPC request served');
      expect(served?.meta).toMatchObject({ chainId: 4663, endpoint: 'primary' });
      expect(JSON.stringify(calls)).not.toContain(primaryUrl);
      expect(JSON.stringify(calls)).not.toContain(fallbackUrl);
    });

    it('a broadcast that fails through the primary is rebroadcast to the fallback with the IDENTICAL signed transaction bytes, never re-signed (this is what makes resending safe: same nonce, same signature, so at most one lands)', async () => {
      const primaryUrl = 'https://primary.example.com';
      const fallbackUrl = 'https://fallback.example.com';
      const signedTx = '0x02f86f0180843b9aca0084ee6b280082520894deadbeefdeadbeefdeadbeefdeadbeefdeadbeef880de0b6b3a764000080c080a0deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefa0deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      const sentParams: unknown[] = [];

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: { body: string }) => {
          const body = JSON.parse(init.body) as { method: string; params: unknown[] };
          if (body.method === 'eth_sendRawTransaction') {
            sentParams.push(body.params[0]);
            if (url.startsWith(primaryUrl)) throw new TypeError('fetch failed');
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xhash' }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          throw new Error(`unexpected method in test: ${body.method}`);
        }),
      );

      const client = createChainPublicClient({ RPC_ROBINHOOD_PRIMARY: primaryUrl, RPC_ROBINHOOD_FALLBACK: fallbackUrl } as unknown as AppConfig, 4663);
      const hash = await client.sendRawTransaction({ serializedTransaction: signedTx as `0x02${string}` });

      expect(hash).toBe('0xhash');
      expect(sentParams).toEqual([signedTx, signedTx]); // the exact same signed bytes both times, no re-signing possible at this layer
    });
  });
});

describe('firstToSucceed', () => {
  const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  const failAfter = (ms: number, message: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms));

  it('returns the faster sender, and starts them all at once', async () => {
    const started: number[] = [];
    const winners: number[] = [];
    const result = await firstToSucceed(
      [
        () => (started.push(0), after(40, 'slow')),
        () => (started.push(1), after(5, 'fast')),
      ],
      (i) => winners.push(i),
    );
    expect(result).toBe('fast');
    expect(started).toEqual([0, 1]);
    expect(winners[0]).toBe(1);
  });

  it('a sender that fails first does not win: the one that succeeds later does', async () => {
    expect(await firstToSucceed([() => failAfter(1, 'already known'), () => after(15, 'ok')])).toBe('ok');
  });

  it('when all fail, throws the first sender\'s error (the primary\'s)', async () => {
    await expect(firstToSucceed([() => failAfter(15, 'primary said no'), () => failAfter(1, 'fallback said no')])).rejects.toThrow('primary said no');
  });
});

describe('createRaceBroadcaster', () => {
  afterEach(() => vi.unstubAllGlobals());
  const primaryUrl = 'https://primary.example.com';
  const fallbackUrl = 'https://fallback.example.com';
  const both = { RPC_ROBINHOOD_PRIMARY: primaryUrl, RPC_ROBINHOOD_FALLBACK: fallbackUrl, RPC_RACE_BROADCAST: true } as unknown as AppConfig;
  const signedTx = `0x02${'ab'.repeat(60)}` as `0x${string}`;
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  const rpcError = (message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('is not built with one endpoint, or with the switch off', () => {
    const client = createChainPublicClient(both, 4663);
    expect(createRaceBroadcaster({ RPC_ROBINHOOD_PRIMARY: primaryUrl, RPC_RACE_BROADCAST: true } as unknown as AppConfig, 4663, client)).toBeUndefined();
    expect(createRaceBroadcaster({ ...both, RPC_RACE_BROADCAST: false } as unknown as AppConfig, 4663, client)).toBeUndefined();
    expect(createRaceBroadcaster(both, 4663, client)).toBeDefined();
  });

  it('hands the identical signed bytes to both endpoints at once and takes the faster answer; the slower "already known" is ignored', async () => {
    const sent: Array<{ to: string; tx: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { method: string; params: unknown[] };
        if (body.method !== 'eth_sendRawTransaction') throw new Error(`unexpected method in test: ${body.method}`);
        const primary = url.startsWith(primaryUrl);
        sent.push({ to: primary ? 'primary' : 'fallback', tx: body.params[0] });
        if (primary) {
          await new Promise((resolve) => setTimeout(resolve, 40)); // the slow one
          return rpcError('already known');
        }
        return ok('0xhash');
      }),
    );
    const { logger, calls } = fakeLogger();
    const race = createRaceBroadcaster(both, 4663, createChainPublicClient(both, 4663), logger)!;

    const started = Date.now();
    expect(await race.send(signedTx)).toBe('0xhash');
    expect(Date.now() - started).toBeLessThan(35); // did not wait for the slow primary
    expect(sent.map((s) => s.to).sort()).toEqual(['fallback', 'primary']);
    expect(sent.every((s) => s.tx === signedTx)).toBe(true);
    expect(calls.some((c) => c.msg === 'broadcast accepted first by' && c.meta?.endpoint === 'fallback')).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('example.com');
  });

  it('a real refusal from every endpoint is thrown as the primary reported it, with no further attempt', async () => {
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests++;
        return rpcError(url.startsWith(primaryUrl) ? 'nonce too low' : 'nonce too low (fallback)');
      }),
    );
    const race = createRaceBroadcaster(both, 4663, createChainPublicClient(both, 4663))!;
    await expect(race.send(signedTx)).rejects.toThrow(/nonce too low/);
    expect(requests).toBe(2);
  });

  it('when both endpoints cannot be reached, the ordinary client gets one more pass', async () => {
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        requests++;
        if (requests <= 2) throw new TypeError('fetch failed');
        return ok('0xlate');
      }),
    );
    const race = createRaceBroadcaster(both, 4663, createChainPublicClient(both, 4663))!;
    expect(await race.send(signedTx)).toBe('0xlate');
    expect(requests).toBe(3);
  });

  it('warm reads once from every endpoint', async () => {
    const hit = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        hit.add(url.startsWith(primaryUrl) ? 'primary' : 'fallback');
        return ok('0x1');
      }),
    );
    createRaceBroadcaster(both, 4663, createChainPublicClient(both, 4663))!.warm();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([...hit].sort()).toEqual(['fallback', 'primary']);
  });
});
