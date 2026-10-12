import { describe, expect, it } from 'vitest';
import { redactUrls, shortError } from '../src/lib/short-error';

describe('shortError', () => {
  it('returns an empty string for nothing', () => {
    expect(shortError(undefined)).toBe('');
    expect(shortError(null)).toBe('');
    expect(shortError('  \n ')).toBe('');
  });

  it('leaves a short message alone', () => {
    expect(shortError('Not enough funds.')).toBe('Not enough funds.');
  });

  it('keeps only the first non-empty line', () => {
    expect(shortError('\nfirst line\nsecond line')).toBe('first line');
  });

  it('cuts chain-client boilerplate that follows on the same line', () => {
    expect(shortError('execution reverted Request Arguments: from: 0xabc')).toBe('execution reverted');
    expect(shortError('boom Details: x Version: viem@2')).toBe('boom');
  });

  it('caps long text at a word boundary with an ellipsis', () => {
    const out = shortError('word '.repeat(60), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\swor…$/); // not cut mid-word
  });

  it('keeps a long unbroken token (like a revert name) rather than trimming back to before it', () => {
    const out = shortError('Reverted: execution reverted: PayerNotAllowed(0xabc0000000000000000000000000000000000000)', 60);
    expect(out).toContain('PayerNotAllowed');
    expect(out).toHaveLength(60);
  });

  it('hard-cuts a single long token that has no spaces', () => {
    const out = shortError('x'.repeat(200), 30);
    expect(out).toHaveLength(30);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('redactUrls', () => {
  it('replaces every URL, keeping the rest of the message', () => {
    expect(redactUrls('The request took too long to respond.\n\nURL: https://rpc.example.io/v2/SECRETKEY123\nRequest Arguments: none')).toBe(
      'The request took too long to respond.\n\nURL: [url]\nRequest Arguments: none',
    );
    expect(redactUrls('a http://x.y/z and (https://p.q/r?key=1) done')).toBe('a [url] and ([url]) done');
  });

  it('leaves text without a URL alone', () => {
    expect(redactUrls('Simulation reverted: PayerNotAllowed')).toBe('Simulation reverted: PayerNotAllowed');
  });
});
