import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { NativePriceService } from '../src/native-price.service.js';
import { nativePriceController } from '../src/native-price-controller.js';
import { registerResponseRedaction } from '../src/response-redaction.js';

const logger = () => {
  const errors: { message: string; fields: Record<string, unknown> }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { errors, logger: { debug() {}, info() {}, warn() {}, error: (message: string, fields: Record<string, unknown> = {}) => void errors.push({ message, fields }) } as any };
};

async function buildApp(getUsdPrice: (chainId: number) => Promise<number | null>, configuredChainIds = [1, 46630]) {
  const app = Fastify();
  const { logger: log, errors } = logger();
  registerResponseRedaction(app, log);
  await app.register(nativePriceController({ nativePriceService: new NativePriceService({ getUsdPrice }), configuredChainIds, logger: log }));
  return { app, errors };
}

describe('GET /chains/:chainId/native-price', () => {
  it('returns the USD price for a mapped chain', async () => {
    const { app } = await buildApp(async () => 2738.82);
    const res = await app.inject({ method: 'GET', url: '/chains/1/native-price' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chainId: 1, usdPerToken: 2738.82 });
  });

  it('returns null (still 200) for an unmapped chain: unavailable is a normal answer, not an error', async () => {
    const { app } = await buildApp(async () => null);
    const res = await app.inject({ method: 'GET', url: '/chains/46630/native-price' });
    expect(res.statusCode).toBe(200);
    expect(res.json().usdPerToken).toBeNull();
  });

  it('returns 400 for a chain this instance has no RPC for', async () => {
    const { app } = await buildApp(async () => 1, [1]);
    const res = await app.inject({ method: 'GET', url: '/chains/999/native-price' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_chain');
  });

  it('returns 502 with a fixed message, not the raw error, when the reader throws', async () => {
    const { app, errors } = await buildApp(async () => {
      throw new Error(`HTTP request failed.\n\nURL: https://rpc.example.com/v2/SUPERSECRET`);
    });
    const res = await app.inject({ method: 'GET', url: '/chains/1/native-price' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('price_unavailable');
    expect(res.body).not.toContain('SUPERSECRET');
    expect(errors.some((e) => String(e.fields.message).includes('SUPERSECRET'))).toBe(true); // full detail still logged
  });
});
