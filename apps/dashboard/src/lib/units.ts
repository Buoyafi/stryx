/** Exact decimal <-> wei conversion with bigint, no floating point anywhere. */
export const NATIVE_DECIMALS = 18;

export type AmountProblem = 'format' | 'decimals' | 'zero';

export type ParsedAmount = { ok: true; wei: bigint } | { ok: false; problem: AmountProblem };

const DECIMAL = /^\d+(\.\d+)?$/;

export function parseAmount(input: string, decimals = NATIVE_DECIMALS): ParsedAmount {
  const value = input.trim();
  if (!DECIMAL.test(value)) return { ok: false, problem: 'format' };
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  if (fraction.length > decimals) return { ok: false, problem: 'decimals' };
  const wei = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (wei === 0n) return { ok: false, problem: 'zero' };
  return { ok: true, wei };
}

export function amountProblemText(problem: AmountProblem): string {
  switch (problem) {
    case 'format':
      return 'Enter a plain decimal number, like 0.01.';
    case 'decimals':
      return 'Too many decimal places (18 at most).';
    case 'zero':
      return 'The amount must be more than zero.';
  }
}

/** Exact decimal text for a wei amount, trailing zeros trimmed: 1500000000000000n -> "0.0015". */
export function formatWei(wei: bigint, decimals = NATIVE_DECIMALS): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** The decimal string the server's disperse route takes (it accepts a plain decimal amount). */
export const weiToDecimalString = (wei: bigint): string => formatWei(wei);

export const sumWei = (values: readonly bigint[]): bigint => values.reduce((total, v) => total + v, 0n);
