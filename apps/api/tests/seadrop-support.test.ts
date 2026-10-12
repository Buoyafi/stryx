import { describe, expect, it } from 'vitest';
import { SeaDropSupport, seaDropMissingMessage } from '../src/seadrop-support.js';

function client(answers: Array<`0x${string}` | undefined | Error>) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async getCode() {
      const a = answers[Math.min(calls++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

describe('SeaDropSupport', () => {
  it('deployed: true, read once and cached for good', async () => {
    const c = client(['0x6080']);
    const s = new SeaDropSupport(c as never);
    expect(await s.isDeployed()).toBe(true);
    expect(await s.isDeployed()).toBe(true);
    expect(c.calls).toBe(1);
  });

  it('no code: false, re-checked after 10 minutes (it could be deployed later)', async () => {
    let now = 0;
    const c = client(['0x', '0x6080']);
    const s = new SeaDropSupport(c as never, () => now);
    expect(await s.isDeployed()).toBe(false);
    now = 599_000;
    expect(await s.isDeployed()).toBe(false);
    expect(c.calls).toBe(1);
    now = 601_000;
    expect(await s.isDeployed()).toBe(true);
  });

  it('a failed read is unknown (null), never cached, never a "no"', async () => {
    const c = client([new Error('timeout'), '0x6080']);
    const s = new SeaDropSupport(c as never);
    expect(await s.isDeployed()).toBeNull();
    expect(await s.isDeployed()).toBe(true);
  });

  it('message names the chain and says what still works', () => {
    expect(seaDropMissingMessage('Abstract')).toMatch(/^Minting isn't supported on Abstract yet: SeaDrop \(0x00005EA0.*isn't deployed there\. Balances and Disperse still work\.$/);
  });
});
