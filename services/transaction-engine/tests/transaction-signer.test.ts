import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverTransactionAddress } from 'viem';
import { WalletKeyService, LocalKeyManagementProvider, type EncryptedPrivateKeyRecord } from '@stryx/key-management';
import { TransactionSigner } from '../src/service/transaction-signer.service.js';

async function rig() {
  const walletId = 'wallet-1';
  const privateKey = generatePrivateKey();
  const kms = new LocalKeyManagementProvider();
  let unwraps = 0;
  const deks: Buffer[] = [];
  let gate: Promise<void> | null = null;
  const countingKms = Object.assign(Object.create(Object.getPrototypeOf(kms)), kms, {
    unwrapDek: async (wrapped: Buffer) => {
      unwraps++;
      if (gate) await gate;
      const dek = await kms.unwrapDek(wrapped);
      deks.push(dek);
      return dek;
    },
  }) as LocalKeyManagementProvider;
  const keys = new WalletKeyService(countingKms);
  const record = await keys.encryptPrivateKeyForStorage({ walletId }, Buffer.from(privateKey.slice(2), 'hex'));
  let reads = 0;
  const provider = {
    async getRecord(id: string): Promise<EncryptedPrivateKeyRecord> {
      if (id !== walletId) throw new Error('unknown wallet');
      reads++;
      return record;
    },
  };
  let now = 1_000_000;
  const signer = new TransactionSigner(keys, provider, () => now);
  const tx = { chainId: 1, type: 'eip1559' as const, to: privateKeyToAccount(privateKey).address, value: 1n, nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
  return {
    signer,
    walletId,
    address: privateKeyToAccount(privateKey).address,
    tx,
    reads: () => reads,
    unwraps: () => unwraps,
    advance: (ms: number) => (now += ms),
    /** Every data key KMS handed out, to check each one ends up zeroed. */
    deks,
    /** Makes the next KMS unwrap wait until the returned function is called. */
    holdKms: () => {
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
  };
}

describe('TransactionSigner.prepare', () => {
  it('fetches the record and opens KMS ahead; the next signature reuses that record and still signs correctly', async () => {
    const r = await rig();
    await r.signer.prepare(r.walletId);
    expect(r.reads()).toBe(1);
    expect(r.unwraps()).toBe(1); // the throwaway warm unwrap

    const signed = await r.signer.sign(r.walletId, r.tx);
    expect(r.reads()).toBe(1); // no second database read on the critical path
    expect(r.unwraps()).toBe(2); // signing still unwraps for real
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(r.address);
  });

  it('a prepared record is used once: the following signature fetches afresh', async () => {
    const r = await rig();
    await r.signer.prepare(r.walletId);
    await r.signer.sign(r.walletId, r.tx);
    await r.signer.sign(r.walletId, r.tx);
    expect(r.reads()).toBe(2);
  });

  it('a prepared record older than two minutes is not used', async () => {
    const r = await rig();
    await r.signer.prepare(r.walletId);
    r.advance(121_000);
    await r.signer.sign(r.walletId, r.tx);
    expect(r.reads()).toBe(2);
  });
});

describe('TransactionSigner: holding a data key for a time-critical signature', () => {
  const zeroed = (b: Buffer) => b.every((byte) => byte === 0);
  afterEach(() => vi.useRealTimers());

  it('the signature needs no KMS call, is still correct, and the held key is zeroed after its one use', async () => {
    const r = await rig();
    await r.signer.prepare(r.walletId, { holdKeyMs: 60_000 });
    expect(r.unwraps()).toBe(1);
    expect(r.signer.heldCount()).toBe(1);

    const signed = await r.signer.sign(r.walletId, r.tx);

    expect(r.unwraps()).toBe(1); // nothing at signing time
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(r.address);
    expect(r.signer.heldCount()).toBe(0);
    expect(r.deks.every(zeroed)).toBe(true);
  });

  it('is used once: the signature after it goes back through KMS', async () => {
    const r = await rig();
    await r.signer.prepare(r.walletId, { holdKeyMs: 60_000 });
    await r.signer.sign(r.walletId, r.tx);
    await r.signer.sign(r.walletId, r.tx);
    expect(r.unwraps()).toBe(2);
    expect(r.deks.every(zeroed)).toBe(true);
  });

  it('release zeroes it at once, and the next signature still works the normal way', async () => {
    const r = await rig();
    await r.signer.prepare(r.walletId, { holdKeyMs: 60_000 });
    r.signer.release(r.walletId);

    expect(r.signer.heldCount()).toBe(0);
    expect(zeroed(r.deks[0]!)).toBe(true);
    const signed = await r.signer.sign(r.walletId, r.tx);
    expect(await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` })).toBe(r.address);
    expect(r.unwraps()).toBe(2);
  });

  it('is zeroed when its time is up, with nobody calling release', async () => {
    vi.useFakeTimers();
    const r = await rig();
    await r.signer.prepare(r.walletId, { holdKeyMs: 60_000 });

    vi.advanceTimersByTime(59_999);
    expect(r.signer.heldCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(r.signer.heldCount()).toBe(0);
    expect(zeroed(r.deks[0]!)).toBe(true);
  });

  it('a release that lands while KMS is still answering: the key that arrives is zeroed, never kept', async () => {
    const r = await rig();
    const openKms = r.holdKms();
    const preparing = r.signer.prepare(r.walletId, { holdKeyMs: 60_000 });
    r.signer.release(r.walletId); // the wallet finished (or the job was cancelled) first
    openKms();
    await preparing;

    expect(r.signer.heldCount()).toBe(0);
    expect(r.deks).toHaveLength(1);
    expect(zeroed(r.deks[0]!)).toBe(true);
  });

  it('preparing again replaces the held key and zeroes the old one', async () => {
    const r = await rig();
    await r.signer.prepare(r.walletId, { holdKeyMs: 60_000 });
    await r.signer.prepare(r.walletId, { holdKeyMs: 60_000 });
    expect(r.signer.heldCount()).toBe(1);
    expect(zeroed(r.deks[0]!)).toBe(true);
    expect(zeroed(r.deks[1]!)).toBe(false);
    r.signer.release(r.walletId);
    expect(zeroed(r.deks[1]!)).toBe(true);
  });

  it('without holdKeyMs nothing is held, exactly as before', async () => {
    const r = await rig();
    await r.signer.prepare(r.walletId);
    expect(r.signer.heldCount()).toBe(0);
    expect(r.deks.every(zeroed)).toBe(true);
  });
});
