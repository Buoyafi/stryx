import { describe, expect, it } from 'vitest';
import { CallExecutionError, RawContractError } from 'viem';
import { SimulationRevertedError } from '../src/types/errors.js';

const scope = {
  chainId: 1,
  walletId: 'w1',
  walletAddress: '0x0000000000000000000000000000000000dead' as const,
  ownerId: 'owner-1',
  spendCapWei: null,
};

describe('SimulationRevertedError.revertData', () => {
  it('recovers the raw revert bytes from a real viem error chain', () => {
    const raw = new RawContractError({ data: '0xdeadbeef', message: 'execution reverted' });
    const callError = new CallExecutionError(raw, { to: '0x0000000000000000000000000000000000dead' });

    const err = new SimulationRevertedError(scope, callError);

    expect(err.revertData).toBe('0xdeadbeef');
  });

  it('returns undefined when the cause carries no revert data', () => {
    const err = new SimulationRevertedError(scope, new Error('network error, no revert data at all'));

    expect(err.revertData).toBeUndefined();
  });

  it('returns undefined when the cause is not an Error at all', () => {
    const err = new SimulationRevertedError(scope, 'a plain string rejection');

    expect(err.revertData).toBeUndefined();
  });
});
