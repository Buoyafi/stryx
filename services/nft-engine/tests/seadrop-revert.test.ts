import { describe, expect, it } from 'vitest';
import { encodeErrorResult, toFunctionSelector } from 'viem';
import { decodeSeaDropRevertData } from '../src/utils/seadrop-revert.js';
import { SEADROP_ABI } from '../src/utils/seadrop-abi.js';

describe('decodeSeaDropRevertData', () => {
  it('decodes a known SeaDrop error into its name and args', () => {
    const data = encodeErrorResult({
      abi: SEADROP_ABI,
      errorName: 'IncorrectPayment',
      args: [1_000_000_000_000_000n, 2_000_000_000_000_000n],
    });

    expect(decodeSeaDropRevertData(data)).toBe('IncorrectPayment(1000000000000000, 2000000000000000)');
  });

  it('decodes a zero-argument error by name alone', () => {
    const data = encodeErrorResult({ abi: SEADROP_ABI, errorName: 'MintQuantityCannotBeZero', args: [] });

    expect(decodeSeaDropRevertData(data)).toBe('MintQuantityCannotBeZero');
  });

  it('decodes MintQuantityExceedsMaxMintedPerWallet by name and args: the exact error a per-wallet cap hit produces, previously misreported as "unknown reason"', () => {
    const data = encodeErrorResult({
      abi: SEADROP_ABI,
      errorName: 'MintQuantityExceedsMaxMintedPerWallet',
      args: [11n, 10n],
    });

    expect(decodeSeaDropRevertData(data)).toBe('MintQuantityExceedsMaxMintedPerWallet(11, 10)');
  });

  it('decodes PayerNotAllowed by name: regression for the wrong-selector bug (previously declared with a bogus `address payer` argument)', () => {
    const data = encodeErrorResult({ abi: SEADROP_ABI, errorName: 'PayerNotAllowed', args: [] });

    expect(decodeSeaDropRevertData(data)).toBe('PayerNotAllowed');
  });

  it('returns undefined for revert data that matches no known SeaDrop error', () => {
    // A well-formed but unrecognized 4-byte selector followed by garbage.
    expect(decodeSeaDropRevertData('0xdeadbeef0000000000000000000000000000000000000000000000000000')).toBeUndefined();
  });

  it("PayerNotAllowed's selector matches the REAL deployed contract's no-argument error, not a hand-guessed signature, verified against ProjectOpenSea/seadrop's actual source", () => {
    // Guards against declaring `PayerNotAllowed` with an argument, which computes a different selector
    // than the real error.
    const entry = SEADROP_ABI.find((item) => item.type === 'error' && item.name === 'PayerNotAllowed');
    expect(entry?.inputs).toEqual([]);
    expect(toFunctionSelector('PayerNotAllowed()')).toBe('0x1fe7da08');
  });
});
