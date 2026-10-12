import { describe, expect, it } from 'vitest';
import { withTimeout, TimeoutBudgetExceededError } from '../src/with-timeout.js';

describe('withTimeout', () => {
  it('resolves normally when the promise settles before the deadline', async () => {
    const result = await withTimeout(Promise.resolve('done'), 1000, 'test op');
    expect(result).toBe('done');
  });

  it('rejects with a labeled TimeoutBudgetExceededError when the promise does not settle in time', async () => {
    const neverSettles = new Promise<string>(() => undefined);

    await expect(withTimeout(neverSettles, 10, 'slow RPC call')).rejects.toThrow('slow RPC call timed out after 10ms');
    await expect(withTimeout(neverSettles, 10, 'slow RPC call')).rejects.toBeInstanceOf(TimeoutBudgetExceededError);
  });

  it('propagates the original rejection when the promise fails before the deadline', async () => {
    await expect(withTimeout(Promise.reject(new Error('real failure')), 1000, 'test op')).rejects.toThrow(
      'real failure',
    );
  });
});
