import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerResponseRedaction } from '../src/response-redaction.js';

const KEY_URL = 'https://rpc.provider.io/v2/SUPERSECRETKEY';

function rig() {
  const warnings: { message: string; fields: Record<string, unknown> }[] = [];
  const logger = {
    debug() {},
    info() {},
    error() {},
    warn(message: string, fields: Record<string, unknown> = {}) {
      warnings.push({ message, fields });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const app = Fastify();
  registerResponseRedaction(app, logger);
  return { app, warnings };
}

describe('response redaction guard', () => {
  it('scrubs every string of an error response, and logs it once, server-side, with the URL cut to its domain', async () => {
    const { app, warnings } = rig();
    app.get('/x', async (_req, reply) => reply.code(502).send({ error: 'drop_read_failed', message: `HTTP request failed.\n\nURL: ${KEY_URL}\nVersion: viem@2`, extra: [`see ${KEY_URL}`] }));
    const res = await app.inject('/x');
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('SUPERSECRETKEY');
    expect(res.body).not.toMatch(/https?:\/\//);
    expect(res.json().message).toBe('HTTP request failed.\n\nURL: [url]\nVersion: viem@2');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields.original).toContain('URL: [url: provider.io]');
    expect(JSON.stringify(warnings[0])).not.toContain('SUPERSECRETKEY'); // the key stays out of the log too
    expect(warnings[0]!.fields).toMatchObject({ route: '/x', statusCode: 502, method: 'GET' });
  });

  it('keeps content-length in step with the rewritten body', async () => {
    const { app } = rig();
    app.get('/x', async (_req, reply) => reply.code(500).send({ message: `boom ${KEY_URL}` }));
    const res = await app.inject('/x');
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body));
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it('on a SUCCESSFUL response, scrubs only the error-text keys and leaves real URLs alone', async () => {
    const { app } = rig();
    app.get('/x', async () => ({
      openSea: { openSeaUrl: 'https://opensea.io/collection/robo', imageUrl: 'https://img.opensea.io/a.png' },
      results: [{ walletId: 'w1', status: 'failed', error: `rpc down ${KEY_URL}`, reason: 'rpc_unavailable' }],
      balances: [{ chainId: 1, error: `timeout at ${KEY_URL}` }],
      outcome: { ok: false, detail: `URL: ${KEY_URL}` },
      failedReason: `URL: ${KEY_URL}`,
    }));
    const res = await app.inject('/x');
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.openSea.openSeaUrl).toBe('https://opensea.io/collection/robo');
    expect(body.openSea.imageUrl).toBe('https://img.opensea.io/a.png');
    expect(body.results[0].error).toBe('rpc down [url]');
    expect(body.balances[0].error).toBe('timeout at [url]');
    expect(body.outcome.detail).toBe('URL: [url]');
    expect(body.failedReason).toBe('URL: [url]');
    expect(res.body).not.toContain('SUPERSECRETKEY');
  });

  it('does not log, or alter anything, when there is nothing to redact', async () => {
    const { app, warnings } = rig();
    app.get('/x', async () => ({ ok: true, url: 'https://opensea.io/x' }));
    app.get('/y', async (_req, reply) => reply.code(404).send({ error: 'not_found', message: 'No such wallet.' }));
    expect((await app.inject('/x')).json()).toEqual({ ok: true, url: 'https://opensea.io/x' });
    expect((await app.inject('/y')).json()).toEqual({ error: 'not_found', message: 'No such wallet.' });
    expect(warnings).toEqual([]);
  });

  it('leaves non-JSON responses and unparseable bodies alone', async () => {
    const { app } = rig();
    app.get('/text', async (_req, reply) => reply.type('text/plain').send(`plain ${KEY_URL}`));
    app.get('/broken', async (_req, reply) => reply.type('application/json').send('{not json ' + KEY_URL));
    expect((await app.inject('/text')).body).toBe(`plain ${KEY_URL}`);
    expect((await app.inject('/broken')).body).toContain(KEY_URL); // not JSON we can rewrite: left exactly as sent
  });

  it('caps how much of a huge original goes into the log line', async () => {
    const { app, warnings } = rig();
    app.get('/x', async (_req, reply) => reply.code(500).send({ message: `${KEY_URL} ${'x'.repeat(10_000)}` }));
    await app.inject('/x');
    expect(String(warnings[0]!.fields.original).length).toBeLessThan(4_100);
  });
});
