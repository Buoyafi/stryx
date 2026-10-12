// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addRecentCollection,
  clearRecentCollections,
  readRecentCollections,
  setRecentCollectionsAccount,
  storageKeyFor,
  toRecentCollectionEntry,
  LEGACY_STORAGE_KEY,
  MAX_RECENT,
} from '../src/lib/recent-collections-store';

function fakeStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}

const KEY = storageKeyFor('alice');
beforeEach(() => setRecentCollectionsAccount({ id: 'alice' }, fakeStorage()));

const ENTRY = { input: '0xabc', contract: '0xAbC0000000000000000000000000000000000A', chainId: 46630, chainName: 'Robinhood Chain Testnet', name: 'Cool Drop', imageUrl: 'https://i.seadn.io/x.png' };

describe('readRecentCollections', () => {
  it('reads nothing from empty storage', () => {
    expect(readRecentCollections(fakeStorage())).toEqual([]);
  });

  it('drops malformed entries rather than throwing', () => {
    const storage = fakeStorage();
    storage.setItem(KEY, JSON.stringify([{ input: 'ok' }, 'not an object', ENTRY_VIEWED()]));
    expect(readRecentCollections(storage)).toHaveLength(1);
  });

  it('reads an empty list from bad JSON rather than throwing', () => {
    const storage = fakeStorage();
    storage.setItem(KEY, '{not json');
    expect(readRecentCollections(storage)).toEqual([]);
  });
});

function ENTRY_VIEWED() {
  return { ...ENTRY, viewedAt: 123 };
}

describe('addRecentCollection', () => {
  it('adds an entry at the front, stamped with the current time', () => {
    const storage = fakeStorage();
    const before = Date.now();
    const result = addRecentCollection(ENTRY, storage);
    expect(result[0]).toMatchObject(ENTRY);
    expect(result[0]!.viewedAt).toBeGreaterThanOrEqual(before);
    expect(readRecentCollections(storage)).toEqual(result);
  });

  it('moves a repeat of the same contract+chain to the front instead of duplicating it', () => {
    const storage = fakeStorage();
    addRecentCollection({ ...ENTRY, input: 'first-time' }, storage);
    addRecentCollection({ ...ENTRY, input: 'a-different-way-to-find-the-same-drop' }, storage);
    const list = readRecentCollections(storage);
    expect(list).toHaveLength(1);
    expect(list[0]!.input).toBe('a-different-way-to-find-the-same-drop');
  });

  it('treats a different chain as a different entry, even with the same contract address', () => {
    const storage = fakeStorage();
    addRecentCollection(ENTRY, storage);
    addRecentCollection({ ...ENTRY, chainId: 4663, chainName: 'Robinhood Chain' }, storage);
    expect(readRecentCollections(storage)).toHaveLength(2);
  });

  it('caps the list at MAX_RECENT, dropping the oldest', () => {
    const storage = fakeStorage();
    for (let i = 0; i < MAX_RECENT + 3; i++) {
      addRecentCollection({ ...ENTRY, contract: `0x${i.toString().padStart(40, '0')}` }, storage);
    }
    const list = readRecentCollections(storage);
    expect(list).toHaveLength(MAX_RECENT);
    // The most recently added (last i) is first.
    expect(list[0]!.contract).toBe(`0x${(MAX_RECENT + 2).toString().padStart(40, '0')}`);
  });

  it('never throws when storage itself throws (private mode / quota)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => addRecentCollection(ENTRY, throwing)).not.toThrow();
    expect(() => setRecentCollectionsAccount({ id: 'alice', claimLegacy: true }, throwing)).not.toThrow();
    expect(() => clearRecentCollections(throwing)).not.toThrow();
  });
});

describe('one list per account', () => {
  it('shows an account only its own collections on a shared browser', () => {
    const storage = fakeStorage();
    addRecentCollection(ENTRY, storage);

    setRecentCollectionsAccount({ id: 'bob' }, storage);
    expect(readRecentCollections(storage)).toEqual([]);
    addRecentCollection({ ...ENTRY, contract: '0x' + 'b'.repeat(40) }, storage);

    setRecentCollectionsAccount({ id: 'alice' }, storage);
    expect(readRecentCollections(storage).map((r) => r.contract)).toEqual([ENTRY.contract]);
  });

  it('keeps and shows nothing while nobody is signed in', () => {
    const storage = fakeStorage();
    setRecentCollectionsAccount(null, storage);
    addRecentCollection(ENTRY, storage);
    expect(readRecentCollections(storage)).toEqual([]);
    setRecentCollectionsAccount({ id: 'alice' }, storage);
    expect(readRecentCollections(storage)).toEqual([]);
  });

  it('sign-out deletes the list from the browser', () => {
    const storage = fakeStorage();
    addRecentCollection(ENTRY, storage);
    clearRecentCollections(storage);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('the list from before accounts goes to the operator, and to nobody else', () => {
    const old = JSON.stringify([ENTRY_VIEWED()]);

    const userBrowser = fakeStorage();
    userBrowser.setItem(LEGACY_STORAGE_KEY, old);
    setRecentCollectionsAccount({ id: 'bob' }, userBrowser);
    expect(readRecentCollections(userBrowser)).toEqual([]);
    expect(userBrowser.getItem(LEGACY_STORAGE_KEY)).toBeNull();

    const operatorBrowser = fakeStorage();
    operatorBrowser.setItem(LEGACY_STORAGE_KEY, old);
    setRecentCollectionsAccount({ id: 'operator', claimLegacy: true }, operatorBrowser);
    expect(readRecentCollections(operatorBrowser)).toHaveLength(1);
    expect(operatorBrowser.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });
});

describe('toRecentCollectionEntry', () => {
  it('carries the external image URL for the recent-list thumbnail', () => {
    const entry = toRecentCollectionEntry('foo', { contract: '0xabc', chainId: 1, chainName: 'Ethereum', name: 'X', image: { kind: 'external', url: 'https://i.seadn.io/x.png' } });
    expect(entry.imageUrl).toBe('https://i.seadn.io/x.png');
  });

  it('does NOT carry a proxied image URL: it would need an authenticated fetch just to preview a dropdown row', () => {
    const entry = toRecentCollectionEntry('foo', { contract: '0xabc', chainId: 1, chainName: 'Ethereum', name: 'X', image: { kind: 'proxied', url: '/chains/1/collections/0xabc/image' } });
    expect(entry.imageUrl).toBeNull();
  });

  it('carries null when there is no image at all', () => {
    const entry = toRecentCollectionEntry('foo', { contract: '0xabc', chainId: 1, chainName: 'Ethereum', name: null, image: null });
    expect(entry.imageUrl).toBeNull();
    expect(entry.name).toBeNull();
  });
});
