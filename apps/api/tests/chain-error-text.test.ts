import { describe, expect, it } from 'vitest';
import { InvalidParamsRpcError, RpcRequestError } from 'viem';
import { chainErrorText } from '../src/chain-error-text.js';
import { classifyEngineError } from '../src/signed-mint-runner.js';

const rawTx = `0x02f902af${'ab'.repeat(600)}`;
const rejected = (nodeMessage: string) =>
  new InvalidParamsRpcError(
    new RpcRequestError({ body: { method: 'eth_sendRawTransaction', params: [rawTx] }, url: 'https://rpc.example/v2/SECRET-API-KEY', error: { code: -32602, message: nodeMessage } }),
  );

describe('chainErrorText', () => {
  it('keeps what the node said and drops the request body and the endpoint', () => {
    const text = chainErrorText(rejected('nonce too high: tx nonce 94, state nonce 90'));
    expect(text).toContain('Node said: nonce too high: tx nonce 94, state nonce 90');
    expect(text).not.toContain('SECRET-API-KEY');
    expect(text).not.toContain('abab');
    expect(text.length).toBeLessThanOrEqual(301);
  });

  it('is one line, and cut to the limit', () => {
    const text = chainErrorText(new Error(`first line\nsecond line ${'x'.repeat(400)}`), 50);
    expect(text).not.toContain('\n');
    expect(text).toHaveLength(51);
  });

  it('handles a thrown non-error', () => {
    expect(chainErrorText('boom')).toBe('boom');
  });
});

describe('classifyEngineError: a send the node rejected', () => {
  it('records the node\'s reason, which the old 300-character cut used to lose behind the raw transaction', () => {
    const { reason, detail } = classifyEngineError(rejected('replacement transaction underpriced'));
    expect(reason).toBe('send_failed');
    expect(detail).toContain('replacement transaction underpriced');
  });
});
