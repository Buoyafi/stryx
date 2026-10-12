import { describe, expect, it } from 'vitest';
import { isValidEmail } from '../src/lib/email.js';

describe('isValidEmail', () => {
  it('accepts an ordinary address', () => {
    expect(isValidEmail('operator@stryx.xyz')).toBe(true);
  });

  it('trims surrounding whitespace before checking', () => {
    expect(isValidEmail('  operator@stryx.xyz  ')).toBe(true);
  });

  it('rejects missing @, missing domain, or a bare word', () => {
    expect(isValidEmail('operatorstryx.xyz')).toBe(false);
    expect(isValidEmail('operator@')).toBe(false);
    expect(isValidEmail('operator@stryx')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
  });

  it('rejects empty, whitespace-only, and non-string input', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('   ')).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });

  it('rejects an address containing a space', () => {
    expect(isValidEmail('operator @stryx.xyz')).toBe(false);
  });

  it('rejects an implausibly long address (254 chars is the practical RFC ceiling)', () => {
    const long = `${'a'.repeat(250)}@b.co`;
    expect(isValidEmail(long)).toBe(false);
  });
});
