/** Address + label export for a batch of wallets. */

/** A spreadsheet runs a cell that starts with one of these as a formula, and a wallet label is free text. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: readonly { address: string; label: string | null }[]): string {
  const lines = rows.map((r) => `${r.address},${csvField(r.label ?? '')}`);
  return ['address,label', ...lines].join('\r\n');
}

/** The first file-download in this dashboard: a Blob + a temporary anchor click, the standard idiom. */
export function downloadTextFile(filename: string, content: string, mimeType = 'text/csv'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
