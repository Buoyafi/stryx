import { describe, expect, it } from 'vitest';
import { MAX_RECIPIENTS, parseAddressList, parseCsv, removeDuplicateRows, validateRecipients, type RecipientRow } from '../src/lib/recipients';
import { CONTRACT_BASE_GAS, CONTRACT_GAS_PER_RECIPIENT, TRANSFER_GAS, chooseSendMode, estimateGas, reviewNumbers, signatureCount, signatureWarning } from '../src/lib/disperse-plan';

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const B = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const C = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
const SOURCE = '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb';
const ETH = 10n ** 18n;

const row = (address: string, over: Partial<RecipientRow> = {}, i = Math.random()): RecipientRow => ({ id: String(i), source: 'pasted', address, ...over });
const opts = (over: Partial<Parameters<typeof validateRecipients>[1]> = {}) => ({ sourceAddress: SOURCE, amountMode: 'same' as const, sameAmount: '0.001', ...over });

describe('parseAddressList', () => {
  it('reads one per line, or separated by commas, semicolons, tabs and spaces, and tracks the line', () => {
    expect(parseAddressList(`${A}\n${B}, ${C}`)).toEqual([{ address: A, line: 1 }, { address: B, line: 2 }, { address: C, line: 2 }]);
    expect(parseAddressList(`${A};${B}\t${C}`).map((r) => r.address)).toEqual([A, B, C]);
  });

  it('copes with blank lines, Windows and old-Mac line endings, and stray whitespace', () => {
    expect(parseAddressList(`\r\n  ${A}  \r\n\r\n${B}\r${C}\r\n`).map((r) => r.address)).toEqual([A, B, C]);
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('   \n  ')).toEqual([]);
  });

  it('keeps garbage as a token, so validation can point at it instead of it vanishing', () => {
    expect(parseAddressList('hello 0x123').map((r) => r.address)).toEqual(['hello', '0x123']);
  });
});

describe('parseCsv', () => {
  it('reads address,amount lines with the line number', () => {
    expect(parseCsv(`${A},0.5\n${B},1.25`).rows).toEqual([
      { address: A, amount: '0.5', line: 1, badColumns: false },
      { address: B, amount: '1.25', line: 2, badColumns: false },
    ]);
  });

  it('skips a header row, but only one that says "address"', () => {
    const r = parseCsv(`address,amount\n${A},1`);
    expect(r.skippedHeader).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.line).toBe(2);
    expect(parseCsv(`Address;Amount\n${A};1`).skippedHeader).toBe(true);
    expect(parseCsv(`wallet,value\n${A},1`).skippedHeader).toBe(false); // an unknown header is NOT guessed at: it becomes a bad row
    expect(parseCsv(`${A},1`).skippedHeader).toBe(false);
  });

  it('accepts semicolons and tabs, quoted cells, blank lines and CRLF', () => {
    expect(parseCsv(`${A};0.5\r\n\r\n${B}\t2\r\n"${C}","3"`).rows.map((r) => [r.address, r.amount])).toEqual([[A, '0.5'], [B, '2'], [C, '3']]);
  });

  it('flags a line that is not exactly two columns instead of guessing (a decimal comma would change the amount)', () => {
    const [euro, tooFew] = parseCsv(`${A},1,5\n${B}`).rows;
    expect(euro!.badColumns).toBe(true); // "1,5" split into two cells
    expect(tooFew!.badColumns).toBe(true);
    expect(parseCsv(`${A},1,5`).rows[0]!.amount).toBe('1'); // never silently becomes 15 or 1.5
  });
});

describe('validateRecipients: addresses', () => {
  it('accepts valid addresses, normalises them to the checksummed form, and totals the amounts', () => {
    const v = validateRecipients([row(A.toLowerCase()), row(B)], opts());
    expect(v.canSend).toBe(true);
    expect(v.valid).toEqual([{ address: A, wei: ETH / 1000n }, { address: B, wei: ETH / 1000n }]);
    expect(v.totalWei).toBe(ETH / 500n);
    expect(v.recipients[0]!.checksum).toBe('none');
    expect(v.recipients[1]!.checksum).toBe('verified');
  });

  it('rejects each bad address inline, with the row, and blocks sending', () => {
    const badChecksum = A.slice(0, 4) + 'a' + A.slice(5); // index 4 is the letter 'A': flipping a real letter's case breaks the checksum
    expect(badChecksum).not.toBe(A);
    const v = validateRecipients([row(A), row('0x123'), row(badChecksum), row('0x' + '0'.repeat(40))], opts());
    expect(v.canSend).toBe(false);
    expect(v.recipients.map((r) => r.ok)).toEqual([true, false, false, false]);
    expect(v.recipients[1]!.errors[0]).toMatch(/starts with 0x/);
    expect(v.recipients[2]!.errors[0]).toMatch(/Checksum/);
    expect(v.recipients[3]!.errors[0]).toMatch(/zero address/);
    expect(v.valid).toHaveLength(1); // only the good one is counted in the total
  });

  it('BLOCKS sending to the source wallet itself, whatever its capitalisation', () => {
    for (const form of [SOURCE, SOURCE.toLowerCase(), '0x' + SOURCE.slice(2).toUpperCase()]) {
      const v = validateRecipients([row(A), row(form)], opts());
      expect(v.canSend, form).toBe(false);
      expect(v.recipients[1]!.errors.join(' ')).toMatch(/source wallet/);
    }
    expect(validateRecipients([row(SOURCE)], opts({ sourceAddress: null })).canSend).toBe(true); // no source chosen yet: nothing to compare
  });

  it('flags EVERY occurrence of a duplicate, even when casing differs, and blocks sending', () => {
    const v = validateRecipients([row(A), row(B), row(A.toLowerCase()), row(A.toUpperCase().replace('0X', '0x'))], opts());
    expect(v.canSend).toBe(false);
    expect(v.recipients[0]!.errors.join(' ')).toMatch(/Duplicated further down/);
    expect(v.recipients[2]!.errors.join(' ')).toMatch(/Duplicate of recipient 1/);
    expect(v.recipients[3]!.errors.join(' ')).toMatch(/Duplicate of recipient 1/);
    expect(v.recipients[1]!.ok).toBe(true);
  });

  it('removeDuplicateRows keeps the first of each and leaves invalid rows for the user to fix', () => {
    const rows = [row(A, {}, 1), row(B, {}, 2), row(A.toLowerCase(), {}, 3), row('0xbad', {}, 4)];
    expect(removeDuplicateRows(rows).map((r) => r.id)).toEqual(['1', '2', '4']);
    expect(validateRecipients(removeDuplicateRows(rows).filter((r) => r.address !== '0xbad'), opts()).canSend).toBe(true);
  });

  it('enforces the recipient limit, and needs at least one', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => row('0x' + (i + 1).toString(16).padStart(40, '0')));
    expect(validateRecipients(many, opts()).canSend).toBe(false);
    expect(validateRecipients(many, opts()).problems.join(' ')).toMatch(/At most 100/);
    expect(validateRecipients(many.slice(0, MAX_RECIPIENTS), opts()).canSend).toBe(true);
    expect(validateRecipients([], opts()).problems).toContain('Add at least one recipient.');
  });

  it('flags a CSV line with the wrong number of columns', () => {
    const v = validateRecipients([row(A, { source: 'csv', badColumns: true, amount: '1' })], opts({ amountMode: 'each' }));
    expect(v.recipients[0]!.errors.join(' ')).toMatch(/two columns/);
    expect(v.canSend).toBe(false);
  });
});

describe('validateRecipients: amounts', () => {
  it('same amount: one shared amount applies to every row, and a bad shared amount blocks everything', () => {
    expect(validateRecipients([row(A), row(B)], opts({ sameAmount: '0.25' })).totalWei).toBe(ETH / 2n);
    const bad = validateRecipients([row(A)], opts({ sameAmount: '0.0000000000000000001' }));
    expect(bad.canSend).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/Too many decimal places/);
    expect(validateRecipients([row(A)], opts({ sameAmount: '' })).canSend).toBe(false);
    expect(validateRecipients([row(A)], opts({ sameAmount: '0' })).canSend).toBe(false);
  });

  it('per recipient: each row carries its own amount, totalled exactly', () => {
    const v = validateRecipients([row(A, { amount: '0.1' }), row(B, { amount: '0.2' }), row(C, { amount: '0.0000000000000001' })], opts({ amountMode: 'each' }));
    expect(v.canSend).toBe(true);
    expect(v.totalWei).toBe(ETH / 10n + ETH / 5n + 100n);
  });

  it('per recipient: a missing, malformed, zero or over-precise amount is that row\'s error', () => {
    const v = validateRecipients([row(A), row(B, { amount: 'abc' }), row(C, { amount: '0' }), row('0x' + '1'.repeat(40), { amount: '1.0000000000000000001' })], opts({ amountMode: 'each' }));
    expect(v.recipients.map((r) => r.errors.length > 0)).toEqual([true, true, true, true]);
    expect(v.recipients[0]!.errors[0]).toBe('Amount required.');
    expect(v.canSend).toBe(false);
  });

  it('warns that a CSV amount is ignored in same-amount mode, without blocking', () => {
    const v = validateRecipients([row(A, { source: 'csv', amount: '9' })], opts());
    expect(v.canSend).toBe(true);
    expect(v.recipients[0]!.warnings.join(' ')).toMatch(/CSV amount ignored/);
    expect(v.totalWei).toBe(ETH / 1000n); // the shared amount, never the CSV one
  });
});

describe('chooseSendMode', () => {
  const withContract = { disperseContract: { address: A, codeHash: '0x' + '1'.repeat(64) } };
  const without = { disperseContract: null };

  it('uses the contract only for a connected wallet, on a chain that lists one, once its code is verified', () => {
    expect(chooseSendMode({ chain: withContract, sourceKind: 'connected', contractVerified: true })).toBe('contract');
    expect(chooseSendMode({ chain: withContract, sourceKind: 'connected', contractVerified: false })).toBe('sequential');
    expect(chooseSendMode({ chain: without, sourceKind: 'connected', contractVerified: true })).toBe('sequential');
  });

  it('always sends our own wallets sequentially (the server does that), even on a chain with a contract', () => {
    expect(chooseSendMode({ chain: withContract, sourceKind: 'custodial', contractVerified: true })).toBe('sequential');
  });
});

describe('signature warning (shown before review)', () => {
  it('counts one signature for the contract, one per recipient for sequential, none for our own wallets', () => {
    expect(signatureCount('contract', 'connected', 40)).toBe(1);
    expect(signatureCount('sequential', 'connected', 40)).toBe(40);
    expect(signatureCount('sequential', 'custodial', 40)).toBe(0);
  });

  it('warns with the agreed wording only when there will be more than one signature', () => {
    expect(signatureWarning('sequential', 'connected', 5)).toBe("This chain sends one transaction per recipient. You'll sign 5 times.");
    expect(signatureWarning('sequential', 'connected', 1)).toBeNull();
    expect(signatureWarning('contract', 'connected', 5)).toBeNull();
    expect(signatureWarning('sequential', 'custodial', 5)).toBeNull();
  });
});

describe('estimateGas and reviewNumbers', () => {
  it('sequential is exactly 21,000 gas per recipient', () => {
    expect(estimateGas({ mode: 'sequential', recipients: 4 })).toEqual({ units: 4n * TRANSFER_GAS, basis: 'exact' });
  });

  it('contract uses the wallet\'s estimate when there is one, and a labelled generous guess when there is not', () => {
    expect(estimateGas({ mode: 'contract', recipients: 10, walletEstimate: 123_456n })).toEqual({ units: 123_456n, basis: 'estimated' });
    expect(estimateGas({ mode: 'contract', recipients: 10 })).toEqual({ units: CONTRACT_BASE_GAS + 10n * CONTRACT_GAS_PER_RECIPIENT, basis: 'rough' });
  });

  it('computes gas cost and the balance left after sending', () => {
    const r = reviewNumbers({ totalWei: 3n * ETH, gasUnits: 63_000n, gasPriceWei: 10_000_000n, balanceWei: 5n * ETH });
    expect(r.gasCostWei).toBe(630_000_000_000n);
    expect(r.remainingWei).toBe(5n * ETH - 3n * ETH - 630_000_000_000n);
    expect(r.enough).toBe(true);
  });

  it('is NOT enough when the amount alone exceeds the balance, or when amount plus gas does', () => {
    expect(reviewNumbers({ totalWei: 6n * ETH, gasUnits: 21_000n, gasPriceWei: 1n, balanceWei: 5n * ETH }).enough).toBe(false);
    expect(reviewNumbers({ totalWei: 5n * ETH, gasUnits: 21_000n, gasPriceWei: 1n, balanceWei: 5n * ETH }).enough).toBe(false); // exactly the balance leaves nothing for gas
    expect(reviewNumbers({ totalWei: 5n * ETH - 21_000n, gasUnits: 21_000n, gasPriceWei: 1n, balanceWei: 5n * ETH }).enough).toBe(true);
  });

  it('never guesses a cost or a remaining balance it cannot know', () => {
    const noPrice = reviewNumbers({ totalWei: ETH, gasUnits: 21_000n, gasPriceWei: undefined, balanceWei: 5n * ETH });
    expect(noPrice.gasCostWei).toBeUndefined();
    expect(noPrice.remainingWei).toBeUndefined();
    const noBalance = reviewNumbers({ totalWei: ETH, gasUnits: 21_000n, gasPriceWei: 1n, balanceWei: undefined });
    expect(noBalance.remainingWei).toBeUndefined();
  });
});
