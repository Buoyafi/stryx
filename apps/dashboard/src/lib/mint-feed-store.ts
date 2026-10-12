import { useSyncExternalStore } from 'react';
import { lowerHash, type DeviceMint, type ReceiptInfo } from './mint-ops';

/** What this browser knows about the mints it fired, kept in localStorage so a reload does not lose them. */
export interface FeedState {
  device: readonly DeviceMint[];
  /** When this device started recording (unix ms). Nothing before it can be known. */
  recordingSince: number;
  /** The newest time of any row dropped to stay under the cap (0 if none). Nothing before it is complete. */
  droppedBefore: number;
  receipts: Readonly<Record<string, ReceiptInfo>>;
  charged: Readonly<Record<string, true>>;
  unconfirmed: ReadonlySet<string>;
  seenPending: ReadonlySet<string>;
}

/** Before records were per account. Only the operator (API token) could mint then, so only the operator inherits it. */
export const LEGACY_STORAGE_KEY = 'stryx-mint-feed-v1';
export const storageKeyFor = (accountId: string): string => `stryx-mint-feed-v2:${accountId}`;
/** Enough for a heavy operator's month; about 250 KB of local storage at this size. */
export const MAX_DEVICE_MINTS = 1000;
/** How many receipts are SAVED beyond those of the mints on record here (those are always saved). */
export const MAX_RECEIPTS = 500;

interface Persisted {
  device: DeviceMint[];
  recordingSince: number | null;
  droppedBefore: number;
  receipts: Record<string, ReceiptInfo>;
  charged: Record<string, true>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isDeviceMint(v: unknown): v is DeviceMint {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.at === 'number' &&
    typeof v.chainId === 'number' &&
    typeof v.nftContract === 'string' &&
    typeof v.walletId === 'string' &&
    typeof v.address === 'string' &&
    typeof v.quantity === 'number' &&
    (v.hash === undefined || typeof v.hash === 'string') &&
    (v.error === undefined || typeof v.error === 'string') &&
    (v.source === undefined || v.source === 'scheduled')
  );
}

function isReceipt(v: unknown): v is ReceiptInfo {
  return isObject(v) && (v.status === 'success' || v.status === 'reverted');
}

/** Reads whatever is there, keeping only well-formed entries. Bad JSON or a bad shape gives an empty state. */
export function parsePersisted(raw: string | null): Persisted {
  const empty: Persisted = { device: [], recordingSince: null, droppedBefore: 0, receipts: {}, charged: {} };
  if (!raw) return empty;
  try {
    const data: unknown = JSON.parse(raw);
    if (!isObject(data)) return empty;
    const device = Array.isArray(data.device) ? data.device.filter(isDeviceMint) : [];
    const receipts: Record<string, ReceiptInfo> = {};
    if (isObject(data.receipts)) for (const [k, v] of Object.entries(data.receipts)) if (isReceipt(v)) receipts[k] = v;
    const charged: Record<string, true> = {};
    if (isObject(data.charged)) for (const k of Object.keys(data.charged)) charged[k] = true;
    const since = typeof data.recordingSince === 'number' && Number.isFinite(data.recordingSince) ? data.recordingSince : null;
    const dropped = typeof data.droppedBefore === 'number' && Number.isFinite(data.droppedBefore) ? data.droppedBefore : 0;
    return { device, recordingSince: since, droppedBefore: dropped, receipts, charged };
  } catch {
    return empty;
  }
}

/** What is saved: everything `keep` names, and the newest `max` of the rest. */
function newestKeys<T>(record: Record<string, T>, max: number, keep: ReadonlySet<string> = new Set()): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= max) return record;
  const others = keys.filter((k) => !keep.has(k));
  const dropped = new Set(others.slice(0, Math.max(0, others.length - max)));
  if (dropped.size === 0) return record;
  return Object.fromEntries(keys.filter((k) => !dropped.has(k)).map((k) => [k, record[k] as T]));
}

export interface MintFeedStore {
  getSnapshot: () => FeedState;
  subscribe: (listener: () => void) => () => void;
  /** Records mints just fired from this device. Their hashes count as "seen pending". */
  recordMints: (mints: readonly DeviceMint[]) => void;
  /** Keeps the outcomes of scheduled jobs the server is about to forget. */
  recordScheduled: (mints: readonly DeviceMint[]) => void;
  setReceipts: (receipts: Readonly<Record<string, ReceiptInfo>>) => void;
  markPending: (hashes: readonly string[]) => void;
  markUnconfirmed: (hashes: readonly string[]) => void;
  markCharged: (hashes: readonly string[]) => void;
  /** Empties the current account's record, in memory and in storage. */
  clear: () => void;
  /** Switches to an account's record (null: none, memory only). */
  setAccount: (account: { id: string; claimLegacy?: boolean } | null) => void;
}

export interface FeedAccount {
  id: string;
  claimLegacy?: boolean;
}

export function createMintFeedStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, initialAccount: FeedAccount | null = null): MintFeedStore {
  const read = (key: string): string | null => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const remove = (key: string) => {
    try {
      storage?.removeItem(key);
    } catch {
      // ignore
    }
  };
  const empty = (): FeedState => ({ device: [], recordingSince: Date.now(), droppedBefore: 0, receipts: {}, charged: {}, unconfirmed: new Set(), seenPending: new Set() });
  let account: string | null = null;
  let state: FeedState = empty();
  const listeners = new Set<() => void>();

  const write = () => {
    if (!account) return; // no account: memory only
    try {
      const mine = new Set(state.device.flatMap((m) => (m.hash ? [lowerHash(m.hash)] : [])));
      const data: Persisted = {
        device: [...state.device],
        recordingSince: state.recordingSince,
        droppedBefore: state.droppedBefore,
        receipts: newestKeys(state.receipts, MAX_RECEIPTS, mine),
        charged: newestKeys(state.charged, MAX_RECEIPTS, mine),
      };
      storage?.setItem(storageKeyFor(account), JSON.stringify(data));
    } catch {
      // Private mode, quota, or storage disabled: keep working in memory for this session.
    }
  };

  /** Loads an account's record (moving the legacy one over first when asked). */
  const load = (next: FeedAccount | null) => {
    account = next?.id ?? null;
    if (!next) {
      state = empty();
      return;
    }
    let raw = read(storageKeyFor(next.id));
    let claimed = false;
    if (next.claimLegacy) {
      const legacy = read(LEGACY_STORAGE_KEY);
      if (legacy !== null) {
        if (raw === null) {
          raw = legacy;
          claimed = true;
        }
        remove(LEGACY_STORAGE_KEY);
      }
    }
    const persisted = parsePersisted(raw);
    // First run: recording starts now.
    const oldest = persisted.device.reduce((min, m) => Math.min(min, m.at), Number.POSITIVE_INFINITY);
    const recordingSince = persisted.recordingSince ?? Math.min(oldest, Date.now());
    state = { ...persisted, recordingSince, unconfirmed: new Set(), seenPending: new Set() };
    // Written at once when new, or the start time would move forward on every load.
    if (persisted.recordingSince === null || claimed) write();
  };
  load(initialAccount);

  const commit = (next: FeedState) => {
    state = next;
    write();
    listeners.forEach((l) => l());
  };
  const withSet = (set: ReadonlySet<string>, hashes: readonly string[]) => new Set([...set, ...hashes.map(lowerHash)]);

  /** Adds the new ones, keeps the newest MAX_DEVICE_MINTS, and notes how far back the cap cut. */
  const merge = (mints: readonly DeviceMint[]) => {
    if (mints.length === 0) return null;
    const known = new Set(state.device.map((m) => m.id));
    const fresh = mints.filter((m) => !known.has(m.id));
    if (fresh.length === 0) return null;
    const all = [...state.device, ...fresh].sort((a, b) => a.at - b.at);
    const dropped = all.slice(0, Math.max(0, all.length - MAX_DEVICE_MINTS));
    const device = all.slice(dropped.length);
    const droppedBefore = dropped.length > 0 ? Math.max(state.droppedBefore, dropped[dropped.length - 1]!.at) : state.droppedBefore;
    return { fresh, next: { device, droppedBefore } };
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordMints(mints) {
      const merged = merge(mints);
      if (!merged) return;
      const hashes = merged.fresh.flatMap((m) => (m.hash ? [m.hash] : []));
      commit({ ...state, ...merged.next, seenPending: withSet(state.seenPending, hashes) });
    },
    recordScheduled(mints) {
      const merged = merge(mints);
      if (!merged) return;
      commit({ ...state, ...merged.next });
    },
    setReceipts(receipts) {
      const entries = Object.entries(receipts).map(([k, v]) => [lowerHash(k), v] as const);
      if (entries.length === 0) return;
      // Nothing to do when every one is already known as given: no write, no re-render.
      if (entries.every(([k, v]) => state.receipts[k]?.status === v.status && state.receipts[k]?.gasUsed === v.gasUsed)) return;
      commit({ ...state, receipts: { ...state.receipts, ...Object.fromEntries(entries) } });
    },
    markPending(hashes) {
      const seenPending = withSet(state.seenPending, hashes);
      if (seenPending.size !== state.seenPending.size) commit({ ...state, seenPending });
    },
    markUnconfirmed(hashes) {
      const unconfirmed = withSet(state.unconfirmed, hashes);
      if (unconfirmed.size !== state.unconfirmed.size) commit({ ...state, unconfirmed });
    },
    markCharged(hashes) {
      if (hashes.length === 0) return;
      commit({ ...state, charged: { ...state.charged, ...Object.fromEntries(hashes.map((h) => [lowerHash(h), true as const])) } });
    },
    clear() {
      if (account) remove(storageKeyFor(account));
      state = empty();
      listeners.forEach((l) => l());
    },
    setAccount(next) {
      if ((next?.id ?? null) === account) return;
      load(next);
      listeners.forEach((l) => l());
    },
  };
}

function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // accessing it can itself throw when storage is blocked
  }
}

/** The one store the app uses. Empty and memory-only until App sets the signed-in account. */
export const mintFeedStore: MintFeedStore = createMintFeedStore(browserStorage());

export function useMintFeed(store: MintFeedStore = mintFeedStore): FeedState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
