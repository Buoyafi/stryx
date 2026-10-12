/** The one definition of a valid private-key input, shared by the API and the dashboard so they cannot disagree. */

/** A fully normalised private key: `0x` followed by exactly 32 bytes of hex. */
export const PRIVATE_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/;

const BARE_PRIVATE_KEY_PATTERN = /^[a-fA-F0-9]{64}$/;

/** Trims whitespace and adds a missing `0x` prefix. */
export function normalizePrivateKeyInput(raw: string): string {
  const trimmed = raw.trim();
  return BARE_PRIVATE_KEY_PATTERN.test(trimmed) ? `0x${trimmed}` : trimmed;
}

/**
 * Normalise, then validate: the normalised `0x…` key, or `null` if the input isn't a well-formed key
 * even after normalisation.
 */
export function parsePrivateKeyInput(raw: string): `0x${string}` | null {
  const normalized = normalizePrivateKeyInput(raw);
  return PRIVATE_KEY_PATTERN.test(normalized) ? (normalized as `0x${string}`) : null;
}
