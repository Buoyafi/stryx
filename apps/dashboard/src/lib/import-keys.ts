import { parsePrivateKeyInput } from '@stryx/utils/private-key';

/** Most keys one import accepts: each is its own request, and a paste this large is almost certainly a mistake. */
export const MAX_IMPORT_KEYS = 100;

export interface ImportEntry {
  /** 1-based line in what was pasted, so problems can be pointed at without ever echoing a key. */
  line: number;
  key: `0x${string}`;
  label?: string;
}

export type ImportParse =
  | { ok: true; entries: ImportEntry[] }
  | { ok: false; problems: string[] };

/** Turns the import box's text into keys to import. */
export function parseImportKeys(text: string, sharedLabel: string): ImportParse {
  const problems: string[] = [];
  const raw: Array<{ line: number; key: `0x${string}`; label?: string }> = [];
  const seen = new Map<string, number>();

  text.split(/\r?\n/).forEach((content, i) => {
    const line = i + 1;
    if (content.trim() === '') return;
    const comma = content.indexOf(',');
    const keyPart = comma === -1 ? content : content.slice(0, comma);
    const labelPart = comma === -1 ? '' : content.slice(comma + 1).trim();
    const key = parsePrivateKeyInput(keyPart);
    if (key === null) {
      problems.push(`Line ${line} is not a private key (64 hex characters, with or without 0x).`);
      return;
    }
    const first = seen.get(key.toLowerCase());
    if (first !== undefined) {
      problems.push(`Line ${line} repeats the key on line ${first}.`);
      return;
    }
    seen.set(key.toLowerCase(), line);
    raw.push({ line, key, ...(labelPart ? { label: labelPart.slice(0, 64) } : {}) });
  });

  if (problems.length > 0) return { ok: false, problems };
  if (raw.length === 0) return { ok: false, problems: ['Paste at least one private key.'] };
  if (raw.length > MAX_IMPORT_KEYS) return { ok: false, problems: [`${raw.length} keys: at most ${MAX_IMPORT_KEYS} per import.`] };

  const shared = sharedLabel.trim();
  const entries = raw.map((e, i): ImportEntry => {
    if (e.label) return e;
    if (!shared) return { line: e.line, key: e.key };
    return { line: e.line, key: e.key, label: raw.length === 1 ? shared : `${shared} ${i + 1}` };
  });
  return { ok: true, entries };
}

/** How many non-blank lines are in the box, for the button's "Import 3 wallets" wording. */
export function countKeyLines(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').length;
}
