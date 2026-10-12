import { describe, expect, it, vi } from 'vitest';
import { GasPriceService, GAS_PRICE_TTL_MS } from '../src/gas-price.service.js';
import { gasPriceController } from '../src/gas-price-controller.js';
import Fastify from 'fastify';
import { registerResponseRedaction } from '../src/response-redaction.js';

const SECRET_URL = 'https://rpc.provider.io/v2/SUPERSECRETKEY';
const logger = () => {
  const errors: { message: string; fields: Record<string, unknown> }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { errors, logger: { debug() {}, info() {}, warn() {}, error: (message: string, fields: Record<string, unknown> = {}) => void errors.push({ message, fields }) } as any };
};

describe('GasPriceService', () => {
  it('reads from the chain once, then serves the cached price until the TTL passes', async () => {
    let t = 1_000;
    const reader = { getGasPrice: vi.fn(async () => 7n) };
    const svc = new GasPriceService(reader, () => t);
    const first = await svc.get(46630);
    expect(first).toMatchObject({ gasPriceWei: 7n, cached: false, fetchedAt: 1_000 });
    t += GAS_PRICE_TTL_MS - 1;
    expect(await svc.get(46630)).toMatchObject({ gasPriceWei: 7n, cached: true });
    expect(reader.getGasPrice).toHaveBeenCalledTimes(1);
    t += 2;
    expect((await svc.get(46630)).cached).toBe(false);
    expect(reader.getGasPrice).toHaveBeenCalledTimes(2);
  });

  it('caches per chain, not globally', async () => {
    const reader = { getGasPrice: vi.fn(async (id: number) => BigInt(id)) };
    const svc = new GasPriceService(reader);
    expect((await svc.get(1)).gasPriceWei).toBe(1n);
    expect((await svc.get(10)).gasPriceWei).toBe(10n);
    expect(reader.getGasPrice).toHaveBeenCalledTimes(2);
  });

  it('shares one read between concurrent requests for the same chain', async () => {
    let release!: (v: bigint) => void;
    const reader = { getGasPrice: vi.fn(() => new Promise<bigint>((r) => (release = r))) };
    const svc = new GasPriceService(reader);
    const all = Promise.all([svc.get(1), svc.get(1), svc.get(1)]);
    release(5n);
    const results = await all;
    expect(reader.getGasPrice).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.gasPriceWei === 5n)).toBe(true);
  });

  it('never caches a failure, so the next request tries again', async () => {
    const reader = { getGasPrice: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(9n) };
    const svc = new GasPriceService(reader);
    await expect(svc.get(1)).rejects.toThrow('boom');
    expect((await svc.get(1)).gasPriceWei).toBe(9n);
  });
});

describe('GET /chains/:chainId/gas-price', () => {
  function build(reader: { getGasPrice: (id: number) => Promise<bigint> }, configured = [46630]) {
    const { errors, logger: log } = logger();
    const app = Fastify();
    registerResponseRedaction(app, log);
    void app.register(gasPriceController({ gasPriceService: new GasPriceService(reader), configuredChainIds: configured, logger: log }));
    return { app, errors };
  }

  it('returns the price as a string (JSON has no bigint), with when it was read and whether it was cached', async () => {
    const { app } = build({ getGasPrice: async () => 10_000_000n });
    const res = await app.inject('/chains/46630/gas-price');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chainId: 46630, gasPriceWei: '10000000', cached: false });
    expect(typeof res.json().fetchedAt).toBe('number');
    expect((await app.inject('/chains/46630/gas-price')).json().cached).toBe(true);
  });

  it('rejects a chain with no RPC configured, and a malformed id', async () => {
    const { app } = build({ getGasPrice: async () => 1n });
    const res = await app.inject('/chains/137/gas-price');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_chain');
    expect((await app.inject('/chains/abc/gas-price')).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('on a chain failure returns a fixed generic message with NO URL, and logs the full error server-side only', async () => {
    const viemStyle = `HTTP request failed.\n\nURL: ${SECRET_URL}\nDetails: too many requests\nVersion: viem@2.21.0`;
    const { app, errors } = build({ getGasPrice: async () => { throw new Error(viemStyle); } });
    const res = await app.inject('/chains/46630/gas-price');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'rpc_unavailable', message: 'Could not read the gas price from the chain.' });
    expect(res.body).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
    expect(res.body).not.toContain('SUPERSECRETKEY');
    expect(JSON.stringify(errors)).toContain('SUPERSECRETKEY'); // the full text is in the server log
  });
});
