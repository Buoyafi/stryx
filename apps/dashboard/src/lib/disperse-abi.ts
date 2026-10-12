/**
 * Calldata for Disperse.app's `disperseEther(address[] recipients, uint256[] values)`, encoded by hand
 * to avoid a dependency for one fixed layout.
 */
export const DISPERSE_ETHER_SELECTOR = '0xe63d38ed';

const word = (value: bigint): string => value.toString(16).padStart(64, '0');
const MAX_UINT256 = (1n << 256n) - 1n;

export function encodeDisperseEther(recipients: readonly string[], values: readonly bigint[]): string {
  if (recipients.length !== values.length) throw new Error('recipients and values must be the same length');
  for (const r of recipients) if (!/^0x[0-9a-fA-F]{40}$/.test(r)) throw new Error(`not an address: ${r}`);
  for (const v of values) if (v < 0n || v > MAX_UINT256) throw new Error('value out of range');

  const n = BigInt(recipients.length);
  const valuesOffset = 0x40n + 32n + 32n * n;
  return (
    DISPERSE_ETHER_SELECTOR +
    word(0x40n) +
    word(valuesOffset) +
    word(n) +
    recipients.map((r) => r.slice(2).toLowerCase().padStart(64, '0')).join('') +
    word(n) +
    values.map(word).join('')
  );
}
