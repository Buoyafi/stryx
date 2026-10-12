// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMintFeedStore, parsePersisted, MAX_DEVICE_MINTS, MAX_RECEIPTS, LEGACY_STORAGE_KEY, storageKeyFor } from '../src/lib/mint-feed-store';
import type { DeviceMint } from '../src/lib/mint-ops';

const H1 = `0x${'a'.repeat(64)}`;
const mint = (over: Partial<DeviceMint> = {}): DeviceMint => ({ id: 'm1', at: 1000, chainId: 46630, nftContract: '0xc', walletId: 'w', address: '0xa', quantity: 1, hash: H1, ...over });

const ACCOUNT = { id: 'acct-1' };
const KEY = storageKeyFor('acct-1');

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

describe('mint feed store', () => {
  let storage: MemoryStorage;
  beforeEach(() => { storage = new MemoryStorage(); });

  it('records mints, keeps them across a reload, and notifies subscribers', () => {
    const store = createMintFeedStore(storage, ACCOUNT);
    const listener = vi.fn();
    store.subscribe(listener);
    store.recordMints([mint()]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().device).toHaveLength(1);

    const reloaded = createMintFeedStore(storage, ACCOUNT);
    expect(reloaded.getSnapshot().device[0]).toMatchObject({ id: 'm1', hash: H1 });
  });

  it('counts a freshly recorded hash as seen pending this session, but not after a reload', () => {
    const store = createMintFeedStore(storage, ACCOUNT);
    store.recordMints([mint()]);
    expect(store.getSnapshot().seenPending.has(H1)).toBe(true);
    expect(createMintFeedStore(storage, ACCOUNT).getSnapshot().seenPending.size).toBe(0);
  });

  it('does not record the same mint twice, and ignores an empty batch', () => {
    const store = createMintFeedStore(storage, ACCOUNT);
    store.recordMints([mint()]);
    store.recordMints([mint()]);
    store.recordMints([]);
    expect(store.getSnapshot().device).toHaveLength(1);
  });

  it('keeps only the newest MAX_DEVICE_MINTS, and that is enough for a heavy operator (1,000)', () => {
    expect(MAX_DEVICE_MINTS).toBe(1000);
    const store = createMintFeedStore(storage, ACCOUNT);
    store.recordMints(Array.from({ length: MAX_DEVICE_MINTS + 25 }, (_, i) => mint({ id: `m${i}`, at: i, hash: `0x${String(i).padStart(64, '0')}` })));
    const { device } = store.getSnapshot();
    expect(device).toHaveLength(MAX_DEVICE_MINTS);
    expect(device[0]!.id).toBe('m25');
  });

  const hashN = (i: number) => `0x${String(i).padStart(64, '0')}`;

  it('never forgets a receipt while the page is open, however many there are', () => {
    const store = createMintFeedStore(storage, ACCOUNT);
    const many = MAX_RECEIPTS * 3;
    store.recordMints(Array.from({ length: MAX_DEVICE_MINTS }, (_, i) => mint({ id: `m${i}`, at: i, hash: hashN(i) })));
    store.setReceipts(Object.fromEntries(Array.from({ length: many }, (_, i) => [hashN(i), { status: 'success' as const }])));
    const { receipts } = store.getSnapshot();
    expect(Object.keys(receipts)).toHaveLength(many);
    // The first one given is still there: nothing asks for it a second time.
    expect(receipts[hashN(0)]).toEqual({ status: 'success' });
  });

  it('saves the receipt of every mint on record here, and only the newest of the rest', () => {
    const store = createMintFeedStore(storage, ACCOUNT);
    store.recordMints(Array.from({ length: MAX_DEVICE_MINTS }, (_, i) => mint({ id: `m${i}`, at: i, hash: hashN(i) })));
    const others = MAX_RECEIPTS + 40;
    store.setReceipts(Object.fromEntries(Array.from({ length: MAX_DEVICE_MINTS + others }, (_, i) => [hashN(i), { status: 'success' as const }])));
    const saved = parsePersisted(storage.getItem(KEY)).receipts;
    expect(Object.keys(saved)).toHaveLength(MAX_DEVICE_MINTS + MAX_RECEIPTS);
    expect(saved[hashN(0)]).toBeDefined(); // a mint on record: kept
    expect(saved[hashN(MAX_DEVICE_MINTS)]).toBeUndefined(); // the oldest of the rest: not saved
    expect(saved[hashN(MAX_DEVICE_MINTS + others - 1)]).toBeDefined();
  });

  it('giving it receipts it already has changes nothing: no write, no notification', () => {
    const store = createMintFeedStore(storage, ACCOUNT);
    store.setReceipts({ [H1]: { status: 'success', gasUsed: '21000' } });
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.setReceipts({ [H1]: { status: 'success', gasUsed: '21000' } });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
  });

  it('stores receipts and charged hashes, keyed case-insensitively, and persists them', () => {
    const store = createMintFeedStore(storage, ACCOUNT);
    store.setReceipts({ [H1.toUpperCase().replace('0X', '0x')]: { status: 'success', gasUsed: '21000' } });
    store.markCharged([H1]);
    const reloaded = createMintFeedStore(storage, ACCOUNT).getSnapshot();
    expect(reloaded.receipts[H1]).toEqual({ status: 'success', gasUsed: '21000' });
    expect(reloaded.charged[H1]).toBe(true);
  });

  it('does not persist unconfirmed or seen-pending (they are about this session)', () => {
    const store = createMintFeedStore(storage, ACCOUNT);
    store.markUnconfirmed([H1]);
    store.markPending([H1]);
    const reloaded = createMintFeedStore(storage, ACCOUNT).getSnapshot();
    expect(reloaded.unconfirmed.size).toBe(0);
    expect(reloaded.seenPending.size).toBe(0);
  });

  it('starts empty, without throwing, when the stored data is corrupt or the wrong shape', () => {
    for (const raw of ['{not json', '[]', '"x"', '{"device":"no"}', 'null']) {
      storage.setItem(KEY, raw);
      expect(createMintFeedStore(storage, ACCOUNT).getSnapshot().device).toEqual([]);
    }
  });

  it('drops malformed entries but keeps the good ones', () => {
    const parsed = parsePersisted(JSON.stringify({ device: [mint(), { id: 1 }, null], receipts: { [H1]: { status: 'success' }, bad: { status: 'weird' } }, charged: { [H1]: true } }));
    expect(parsed.device).toHaveLength(1);
    expect(Object.keys(parsed.receipts)).toEqual([H1]);
  });

  it('keeps working in memory when storage is unavailable or throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('blocked'); } };
    const store = createMintFeedStore(broken);
    expect(() => store.recordMints([mint()])).not.toThrow();
    expect(store.getSnapshot().device).toHaveLength(1);
    expect(() => createMintFeedStore(null).recordMints([mint()])).not.toThrow();
  });

  it('clear empties everything and the stored copy', () => {
    const store = createMintFeedStore(storage, ACCOUNT);
    store.recordMints([mint()]);
    store.clear();
    expect(store.getSnapshot().device).toEqual([]);
    expect(createMintFeedStore(storage, ACCOUNT).getSnapshot().device).toEqual([]);
  });

  describe('what this device can and cannot know (for the outcomes chart)', () => {
    it('starts recording now on a first run, and writes that down so it does not move forward on every load', () => {
      const before = Date.now();
      const first = createMintFeedStore(storage, ACCOUNT).getSnapshot();
      expect(first.recordingSince).toBeGreaterThanOrEqual(before);
      expect(storage.getItem(KEY)).not.toBeNull();
      const later = createMintFeedStore(storage, ACCOUNT).getSnapshot();
      expect(later.recordingSince).toBe(first.recordingSince);
    });

    it('for an install that has mints but no start time, recording started at its oldest row', () => {
      storage.setItem(KEY, JSON.stringify({ device: [mint({ id: 'a', at: 1_000 }), mint({ id: 'b', at: 9_000_000_000_000 })], receipts: {}, charged: {} }));
      expect(createMintFeedStore(storage, ACCOUNT).getSnapshot().recordingSince).toBe(1_000);
    });

    it('notes how far back the cap cut when it drops old rows, and never moves that marker backwards', () => {
      const store = createMintFeedStore(storage, ACCOUNT);
      expect(store.getSnapshot().droppedBefore).toBe(0);
      store.recordMints(Array.from({ length: MAX_DEVICE_MINTS + 3 }, (_, i) => mint({ id: `m${i}`, at: 10_000 + i, hash: `0x${String(i).padStart(64, '0')}` })));
      expect(store.getSnapshot().droppedBefore).toBe(10_002); // rows 0, 1 and 2 were dropped
      store.recordMints([mint({ id: 'older', at: 5, hash: `0x${'9'.repeat(64)}` })]); // an old one arriving late is dropped at once
      expect(store.getSnapshot().droppedBefore).toBe(10_002);
      expect(createMintFeedStore(storage, ACCOUNT).getSnapshot().droppedBefore).toBe(10_002);
    });

    it('recordScheduled keeps scheduled outcomes but does NOT count them as seen pending', () => {
      const store = createMintFeedStore(storage, ACCOUNT);
      store.recordScheduled([mint({ id: 'tx:s', source: 'scheduled' })]);
      expect(store.getSnapshot().device).toHaveLength(1);
      expect(store.getSnapshot().seenPending.has(H1)).toBe(false); // otherwise an old confirmation could replay the logo
      expect(createMintFeedStore(storage, ACCOUNT).getSnapshot().device[0]!.source).toBe('scheduled');
    });

    it('recordScheduled de-duplicates by id, so seeing the same job every poll adds nothing', () => {
      const store = createMintFeedStore(storage, ACCOUNT);
      const listener = vi.fn();
      store.subscribe(listener);
      store.recordScheduled([mint({ id: 'tx:s', source: 'scheduled' })]);
      store.recordScheduled([mint({ id: 'tx:s', source: 'scheduled' })]);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('drops a stored row with an unknown source rather than trusting it', () => {
      const parsed = parsePersisted(JSON.stringify({ device: [{ ...mint(), source: 'weird' }, { ...mint({ id: 'ok' }), source: 'scheduled' }], receipts: {}, charged: {} }));
      expect(parsed.device.map((m) => m.id)).toEqual(['ok']);
    });
  });
});

describe('mint feed store: one account per record', () => {
  let storage: MemoryStorage;
  beforeEach(() => { storage = new MemoryStorage(); });

  it("never shows one account's mints to another account on the same browser", () => {
    const store = createMintFeedStore(storage, { id: 'alice' });
    store.recordMints([mint({ id: 'alice-mint' })]);
    store.setAccount({ id: 'bob' });
    expect(store.getSnapshot().device).toEqual([]);
    store.recordMints([mint({ id: 'bob-mint', hash: `0x${'b'.repeat(64)}` })]);
    store.setAccount({ id: 'alice' });
    expect(store.getSnapshot().device.map((m) => m.id)).toEqual(['alice-mint']);
  });

  it('signing out (clear, then no account) deletes that account from the browser and leaves the others', () => {
    const store = createMintFeedStore(storage, { id: 'alice' });
    store.recordMints([mint()]);
    store.setAccount({ id: 'bob' });
    store.recordMints([mint()]);
    store.clear();
    store.setAccount(null);
    expect(storage.getItem(storageKeyFor('bob'))).toBeNull();
    expect(storage.getItem(storageKeyFor('alice'))).not.toBeNull();
    expect(store.getSnapshot().device).toEqual([]);
  });

  it('with no account it keeps working in memory but stores nothing', () => {
    const store = createMintFeedStore(storage);
    store.recordMints([mint()]);
    expect(store.getSnapshot().device).toHaveLength(1);
    expect(storage.data.size).toBe(0);
  });

  it('the record from before accounts goes to the operator only, once, and is then gone from the shared key', () => {
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ device: [mint({ id: 'old' })], recordingSince: 500, droppedBefore: 0, receipts: {}, charged: {} }));
    const member = createMintFeedStore(storage, { id: 'member-1' });
    expect(member.getSnapshot().device).toEqual([]); // a member never sees it
    expect(storage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();

    const operator = createMintFeedStore(storage, { id: 'operator', claimLegacy: true });
    expect(operator.getSnapshot().device.map((m) => m.id)).toEqual(['old']);
    expect(operator.getSnapshot().recordingSince).toBe(500);
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(createMintFeedStore(storage, { id: 'operator' }).getSnapshot().device.map((m) => m.id)).toEqual(['old']);
  });
});
