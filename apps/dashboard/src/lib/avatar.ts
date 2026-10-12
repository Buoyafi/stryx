import { keccak_256 } from '@noble/hashes/sha3.js';

export interface AddressGradient {
  /** Degrees for a CSS hue-rotate() filter, applied on top of the token-based gradient. */
  hueRotate: number;
  /** Gradient direction, in degrees. */
  angle: number;
}

/** A deterministic look from an address: the same address always produces the same avatar, with no lookup or network call. */
export function addressGradient(address: string): AddressGradient {
  const bytes = keccak_256(new TextEncoder().encode(address.toLowerCase()));
  const hueRotate = Math.round(((bytes[0] ?? 0) / 255) * 360);
  const angle = Math.round(((bytes[1] ?? 0) / 255) * 360);
  return { hueRotate, angle };
}
