import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** EIP-55 mixed-case checksum addresses. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** The EIP-55 checksummed form of a 40-hex-digit address. Caller guarantees the shape. */
export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak_256(utf8ToBytes(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

export type AddressProblem = 'format' | 'checksum' | 'zero';

export type AddressCheck =
  | {
      ok: true;
      /** Always the checksummed form. */
      address: string;
      /** `verified`: mixed case that matched. `none`: no capitalisation to check. */
      checksum: 'verified' | 'none';
    }
  | { ok: false; problem: AddressProblem };

export function checkAddress(input: string): AddressCheck {
  const value = input.trim();
  if (!ADDRESS_SHAPE.test(value)) return { ok: false, problem: 'format' };
  const digits = value.slice(2);
  const address = toChecksumAddress(value);
  if (address.toLowerCase() === ZERO_ADDRESS) return { ok: false, problem: 'zero' };
  const isMixed = digits !== digits.toLowerCase() && digits !== digits.toUpperCase();
  if (isMixed && address !== value) return { ok: false, problem: 'checksum' };
  return { ok: true, address, checksum: isMixed ? 'verified' : 'none' };
}

export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A short, plain reason for the inline message next to a rejected address. */
export function addressProblemText(problem: AddressProblem): string {
  switch (problem) {
    case 'format':
      return 'Not an address: it starts with 0x and has 40 hex characters.';
    case 'checksum':
      return 'Checksum does not match. A character is probably wrong.';
    case 'zero':
      return 'The zero address burns funds.';
  }
}
