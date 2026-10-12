import { describe, expect, it } from 'vitest';
import { parsePrivateKeyInput } from '@stryx/utils/private-key';
import { ImportWalletInputSchema } from '../src/dto/wallet.dto.js';

const HEX = 'ab'.repeat(32);

/**
 * The API's request schema and the dashboard's check are built from the same primitives; these cases
 * pin the API side to the same answers.
 */
const INPUTS: string[] = [
  HEX,
  `0x${HEX}`,
  ` ${HEX} `,
  `\n0x${HEX}\r\n`,
  `\t${HEX}`,
  HEX.toUpperCase(),
  `0x${HEX.toUpperCase()}`,
  'AbCdEf0123456789'.repeat(4),
  '',
  '   ',
  '0x',
  'ab'.repeat(31),
  'ab'.repeat(33),
  `0x${'ab'.repeat(31)}`,
  `0x${'ab'.repeat(33)}`,
  `0x0x${HEX}`,
  'zz'.repeat(32),
  `${HEX.slice(0, 32)} ${HEX.slice(32)}`,
  '00'.repeat(32),
  `0X${HEX}`,
];

describe('ImportWalletInputSchema.privateKey vs the browser-side parsePrivateKeyInput', () => {
  it.each(INPUTS.map((i) => [JSON.stringify(i.length > 20 ? `${i.slice(0, 6)}…(${i.length} chars)` : i), i] as const))(
    'agree on %s',
    (_label, input) => {
      const server = ImportWalletInputSchema.safeParse({ privateKey: input });
      const browser = parsePrivateKeyInput(input);

      expect(server.success).toBe(browser !== null);
      if (server.success) expect(server.data.privateKey).toBe(browser);
    },
  );

  it('the validation error for a rejected key is static: it never contains the input', () => {
    const secretish = 'zz'.repeat(32);
    const result = ImportWalletInputSchema.safeParse({ privateKey: secretish });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain(secretish);
      expect(result.error.message).not.toContain(secretish);
    }
  });
});
