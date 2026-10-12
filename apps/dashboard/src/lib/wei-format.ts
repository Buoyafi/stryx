/**
 * Formats a wei integer string as a decimal string with `decimals` places, trimming trailing zeros.
 * Never a `number`: wei exceeds its safe range.
 */
export function formatUnits(wei: string, decimals: number): string {
  const value = BigInt(wei);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/** Ether, from wei (18 decimals): mint/disperse prices and balances. */
export function weiToEther(wei: string): string {
  return formatUnits(wei, 18);
}

/** Gwei from wei (9 decimals): the readable unit for gas prices. */
export function weiToGwei(wei: string): string {
  return formatUnits(wei, 9);
}
