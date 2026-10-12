import { addressProblemText, checkAddress, sameAddress } from './address';
import { amountProblemText, parseAmount } from './units';

export type RecipientSource = 'ours' | 'pasted' | 'csv';
export type AmountMode = 'same' | 'each';

/** One line of the recipient list, as entered. Validation is separate: nothing here decides what is allowed. */
export interface RecipientRow {
  id: string;
  source: RecipientSource;
  address: string;
  /** Per-recipient amount text (from a CSV, or typed in "each" mode). */
  amount?: string;
  /** For our own wallets: its label, to show a name beside the address. */
  label?: string;
  /** For pasted or CSV rows: the 1-based line it came from. */
  line?: number;
  /** A CSV line that did not have exactly two columns. */
  badColumns?: boolean;
}

/** Recipients per batch. */
export const MAX_RECIPIENTS = 100;

/** Pasted addresses: one per line, or separated by commas, semicolons, tabs or spaces. */
export function parseAddressList(text: string): { address: string; line: number }[] {
  const out: { address: string; line: number }[] = [];
  text.split(/\r\n|\r|\n/).forEach((lineText, i) => {
    for (const token of lineText.split(/[\s,;]+/)) if (token) out.push({ address: token, line: i + 1 });
  });
  return out;
}

/** Splits one CSV line on a comma, semicolon or tab, honouring double quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (c === '"') quoted = false;
      else current += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { cells.push(current.trim()); current = ''; }
    else current += c;
  }
  cells.push(current.trim());
  return cells;
}

/** CSV "address,amount". */
export function parseCsv(text: string): { rows: { address: string; amount: string; line: number; badColumns: boolean }[]; skippedHeader: boolean } {
  const rows: { address: string; amount: string; line: number; badColumns: boolean }[] = [];
  let skippedHeader = false;
  text.split(/\r\n|\r|\n/).forEach((lineText, i) => {
    if (!lineText.trim()) return;
    const cells = splitCsvLine(lineText);
    if (rows.length === 0 && !skippedHeader && !/^0x/i.test(cells[0] ?? '') && /^address$/i.test(cells[0] ?? '')) {
      skippedHeader = true;
      return;
    }
    rows.push({ address: cells[0] ?? '', amount: cells[1] ?? '', line: i + 1, badColumns: cells.length !== 2 });
  });
  return { rows, skippedHeader };
}

export interface ValidatedRecipient {
  row: RecipientRow;
  /** 1-based position in the list. */
  position: number;
  /** The checksummed address, when it is one. */
  address?: string;
  checksum?: 'verified' | 'none';
  wei?: bigint;
  errors: string[];
  warnings: string[];
  ok: boolean;
}

export interface RecipientValidation {
  recipients: ValidatedRecipient[];
  /** The rows that are fully valid, in order. */
  valid: { address: string; wei: bigint }[];
  totalWei: bigint;
  /** Problems with the list as a whole (none entered, too many, a bad shared amount). */
  problems: string[];
  /** Nothing is wrong anywhere, and there is at least one recipient. */
  canSend: boolean;
}

export function validateRecipients(
  rows: readonly RecipientRow[],
  opts: { sourceAddress: string | null; amountMode: AmountMode; sameAmount: string; max?: number },
): RecipientValidation {
  const max = opts.max ?? MAX_RECIPIENTS;
  const problems: string[] = [];

  let sameWei: bigint | undefined;
  if (opts.amountMode === 'same') {
    const parsed = parseAmount(opts.sameAmount);
    if (parsed.ok) sameWei = parsed.wei;
    else problems.push(`Amount each: ${amountProblemText(parsed.problem)}`);
  }
  if (rows.length === 0) problems.push('Add at least one recipient.');
  if (rows.length > max) problems.push(`At most ${max} recipients per batch (you have ${rows.length}).`);

  // Duplicates are found on the CHECKSUMMED address, so casing cannot hide one.
  const firstSeen = new Map<string, number>();
  const checked = rows.map((row) => checkAddress(row.address));
  checked.forEach((c, i) => {
    if (!c.ok) return;
    const key = c.address.toLowerCase();
    if (!firstSeen.has(key)) firstSeen.set(key, i + 1);
  });

  const recipients: ValidatedRecipient[] = rows.map((row, i) => {
    const position = i + 1;
    const errors: string[] = [];
    const warnings: string[] = [];
    const c = checked[i]!;
    let address: string | undefined;
    let checksum: 'verified' | 'none' | undefined;

    if (row.badColumns) errors.push('Expected two columns: address,amount.');
    if (!c.ok) {
      errors.push(addressProblemText(c.problem));
    } else {
      address = c.address;
      checksum = c.checksum;
      if (opts.sourceAddress && sameAddress(c.address, opts.sourceAddress)) errors.push('This is the source wallet. It cannot send to itself.');
      const first = firstSeen.get(c.address.toLowerCase());
      if (first !== undefined && first !== position) errors.push(`Duplicate of recipient ${first}.`);
      else if (rows.some((_, j) => j !== i && checked[j]?.ok && (checked[j] as { address: string }).address.toLowerCase() === c.address.toLowerCase())) errors.push('Duplicated further down the list.');
      if (c.checksum === 'none') warnings.push('No checksum to verify (all one case).');
    }

    let wei: bigint | undefined;
    if (opts.amountMode === 'same') {
      wei = sameWei;
      if (row.source === 'csv' && row.amount?.trim()) warnings.push('CSV amount ignored: sending the same amount to each.');
    } else if (!row.amount?.trim()) {
      errors.push('Amount required.');
    } else {
      const parsed = parseAmount(row.amount);
      if (parsed.ok) wei = parsed.wei;
      else errors.push(amountProblemText(parsed.problem));
    }

    return { row, position, ...(address ? { address } : {}), ...(checksum ? { checksum } : {}), ...(wei !== undefined ? { wei } : {}), errors, warnings, ok: errors.length === 0 && address !== undefined && wei !== undefined };
  });

  const valid = recipients.filter((r) => r.ok).map((r) => ({ address: r.address!, wei: r.wei! }));
  const totalWei = valid.reduce((sum, r) => sum + r.wei, 0n);
  const canSend = problems.length === 0 && recipients.length > 0 && recipients.every((r) => r.ok);
  return { recipients, valid, totalWei, problems, canSend };
}

/** Drops every row whose address repeats an earlier one, keeping the first. */
export function removeDuplicateRows(rows: readonly RecipientRow[]): RecipientRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const c = checkAddress(row.address);
    if (!c.ok) return true; // invalid rows are for the user to fix, not to silently drop
    const key = c.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
