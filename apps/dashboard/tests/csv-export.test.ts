import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv-export';

describe('toCsv', () => {
  it('produces a header row plus one row per wallet', () => {
    const csv = toCsv([
      { address: '0x1111111111111111111111111111111111111a', label: 'Mint-01' },
      { address: '0x2222222222222222222222222222222222222b', label: 'Mint-02' },
    ]);
    expect(csv).toBe(
      'address,label\r\n' +
        '0x1111111111111111111111111111111111111a,Mint-01\r\n' +
        '0x2222222222222222222222222222222222222b,Mint-02',
    );
  });

  it('writes an empty field for a null label, never "null"', () => {
    const csv = toCsv([{ address: '0x1111111111111111111111111111111111111a', label: null }]);
    expect(csv).toBe('address,label\r\n0x1111111111111111111111111111111111111a,');
  });

  it('quotes a label that contains a comma, quote, or newline', () => {
    const csv = toCsv([{ address: '0x1111111111111111111111111111111111111a', label: 'a, "tricky" label' }]);
    expect(csv).toBe('address,label\r\n0x1111111111111111111111111111111111111a,"a, ""tricky"" label"');
  });

  it('never includes anything beyond address and label (no key material to leak)', () => {
    const csv = toCsv([{ address: '0xabc', label: 'x' }]);
    const [header, row] = csv.split('\r\n');
    expect(header!.split(',')).toHaveLength(2);
    expect(row!.split(',')).toHaveLength(2);
  });

  it('makes a label a spreadsheet would run as a formula into plain text', () => {
    const address = '0x1111111111111111111111111111111111111a';
    const cases: Array<[string, string]> = [
      ['=HYPERLINK("http://evil.example","click")', `"'=HYPERLINK(""http://evil.example"",""click"")"`],
      ['+1+1', "'+1+1"],
      ['-2+3', "'-2+3"],
      ['@SUM(A1)', "'@SUM(A1)"],
      ['\t=1+1', "'\t=1+1"],
      ['\r=1+1', `"'\r=1+1"`],
    ];
    for (const [label, cell] of cases) {
      expect(toCsv([{ address, label }])).toBe(`address,label\r\n${address},${cell}`);
    }
  });

  it('leaves an ordinary label alone, including one with a sign in the middle', () => {
    expect(toCsv([{ address: '0xabc', label: 'Mint-01 = main' }])).toBe('address,label\r\n0xabc,Mint-01 = main');
  });
});
