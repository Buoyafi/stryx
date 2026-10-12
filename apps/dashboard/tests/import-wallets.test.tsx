// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseImportKeys, countKeyLines, MAX_IMPORT_KEYS } from '../src/lib/import-keys';

const K1 = '11'.repeat(32);
const K2 = '0x' + '22'.repeat(32);
const K3 = '33'.repeat(32);

const posted: Array<{ privateKey: string; label?: string }> = [];
let respond: (body: { privateKey: string }) => unknown = () => ({ id: 'w', address: '0xabc' });

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (_path: string, options: { body?: { privateKey: string; label?: string } } = {}) => {
      posted.push(options.body!);
      return respond(options.body!);
    }),
  };
});

import { ApiError } from '../src/lib/api';
import { ImportWalletModal } from '../src/components/ImportWalletModal';

beforeEach(() => {
  posted.length = 0;
  respond = (b) => ({ id: 'w', address: `0xaddr-${b.privateKey.slice(2, 4)}` });
});
afterEach(cleanup);

describe('parseImportKeys', () => {
  it('one key per line, blank lines skipped, 0x added, per-line labels after a comma', () => {
    const r = parseImportKeys(`${K1}\n\n${K2}, Main\n`, '');
    expect(r).toEqual({ ok: true, entries: [{ line: 1, key: `0x${K1}` }, { line: 3, key: K2, label: 'Main' }] });
  });

  it('shared label: as-is for one key, numbered for several, a line label wins', () => {
    expect(parseImportKeys(K1, 'Vault')).toEqual({ ok: true, entries: [{ line: 1, key: `0x${K1}`, label: 'Vault' }] });
    const r = parseImportKeys(`${K1}\n${K2},Own\n${K3}`, 'Batch');
    expect(r.ok && r.entries.map((e) => e.label)).toEqual(['Batch 1', 'Own', 'Batch 3']);
  });

  it('refuses the whole paste on a bad or repeated line, naming lines and never echoing a key', () => {
    const r = parseImportKeys(`${K1}\nnot-a-key-${K3}\n0x${K1}`, '');
    expect(r.ok).toBe(false);
    const text = !r.ok ? r.problems.join(' ') : '';
    expect(text).toContain('Line 2 is not a private key');
    expect(text).toContain('Line 3 repeats the key on line 1');
    expect(text).not.toContain(K1);
    expect(text).not.toContain(K3);
  });

  it('nothing pasted, or too many keys', () => {
    expect(parseImportKeys('  \n', '')).toEqual({ ok: false, problems: ['Paste at least one private key.'] });
    const many = Array.from({ length: MAX_IMPORT_KEYS + 1 }, (_, i) => (i + 1).toString(16).padStart(64, '0')).join('\n');
    expect(parseImportKeys(many, '').ok).toBe(false);
    expect(countKeyLines('a\n\nb\n')).toBe(2);
  });
});

describe('ImportWalletModal', () => {
  function renderModal() {
    const onImported = vi.fn();
    render(<ImportWalletModal onCancel={vi.fn()} onImported={onImported} />);
    return { onImported, box: screen.getByLabelText('Private keys, one per line') as HTMLTextAreaElement };
  }

  it('one key: same flow as before, ending on the address to confirm', async () => {
    const { onImported, box } = renderModal();
    fireEvent.change(box, { target: { value: K1 } });
    fireEvent.click(screen.getByText('Import'));
    expect(await screen.findByText('Wallet imported')).toBeTruthy();
    expect(posted).toEqual([{ privateKey: `0x${K1}` }]);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('several keys: one request each, in order, then a per-line result list; the box is cleared', async () => {
    respond = (b) => {
      if (b.privateKey === K2) throw new ApiError(409, { error: 'exists' });
      return { id: 'w', address: `0xaddr-${b.privateKey.slice(2, 4)}` };
    };
    const { onImported, box } = renderModal();
    fireEvent.change(box, { target: { value: `${K1}\n${K2}\n${K3}` } });
    fireEvent.click(screen.getByText('Import 3 wallets'));
    expect(await screen.findByText('2 imported, 1 already there')).toBeTruthy();
    expect(posted.map((p) => p.privateKey)).toEqual([`0x${K1}`, K2, `0x${K3}`]);
    expect(screen.getByText('0xaddr-11')).toBeTruthy();
    expect(screen.getByText('Already imported.')).toBeTruthy();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(K1);
  });

  it('a bad line blocks the import: nothing is sent, the problem names the line', () => {
    const { box } = renderModal();
    fireEvent.change(box, { target: { value: `${K1}\nnope` } });
    fireEvent.click(screen.getByText('Import 2 wallets'));
    expect(screen.getByText(/Line 2 is not a private key/)).toBeTruthy();
    expect(posted).toHaveLength(0);
  });

  it('the key box is masked until "Show" is ticked', async () => {
    const { box } = renderModal();
    expect(box.className).toContain('import-keys--masked');
    fireEvent.click(screen.getByLabelText('Show'));
    await waitFor(() => expect(box.className).not.toContain('import-keys--masked'));
  });
});
