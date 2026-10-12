/** What was pasted into the collection input, remembered locally so the operator doesn't have to re-find the same link. */
export interface RecentCollection {
  /**
   * The raw text that was pasted (URL, slug, or address): re-submitting it re-resolves the same way a
   * fresh paste would, so a collection whose OpenSea listing changed since is never shown stale.
   */
  input: string;
  contract: string;
  chainId: number;
  chainName: string;
  name: string | null;
  imageUrl: string | null;
  viewedAt: number;
}

/** Before the list was per account. */
export const LEGACY_STORAGE_KEY = 'stryx-recent-collections';
export const storageKeyFor = (accountId: string): string => `stryx-recent-collections-v2:${accountId}`;
export const MAX_RECENT = 8;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

let account: string | null = null;

/** Switches to an account's list (null: none). `claimLegacy` moves the old shared list to this account, once. */
export function setRecentCollectionsAccount(next: { id: string; claimLegacy?: boolean } | null, storage: StorageLike = browserStorage()): void {
  account = next?.id ?? null;
  if (!next) return;
  try {
    const legacy = storage?.getItem(LEGACY_STORAGE_KEY) ?? null;
    if (legacy === null) return;
    if (next.claimLegacy && storage?.getItem(storageKeyFor(next.id)) == null) storage?.setItem(storageKeyFor(next.id), legacy);
    // Whoever it was, the shared copy goes: the next account on this browser must not find it.
    storage?.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing to move.
  }
}

/** Deletes the current account's list from this browser. Called on sign-out. */
export function clearRecentCollections(storage: StorageLike = browserStorage()): void {
  try {
    if (account) storage?.removeItem(storageKeyFor(account));
  } catch {
    // Storage blocked: there was nothing stored either.
  }
}

function browserStorage(): StorageLike {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // touching localStorage can itself throw when storage is blocked
  }
}

function isRecentCollection(v: unknown): v is RecentCollection {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.input === 'string' &&
    typeof r.contract === 'string' &&
    typeof r.chainId === 'number' &&
    typeof r.chainName === 'string' &&
    (r.name === null || typeof r.name === 'string') &&
    (r.imageUrl === null || typeof r.imageUrl === 'string') &&
    typeof r.viewedAt === 'number'
  );
}

/** Whatever is stored, keeping only well-formed entries. Bad JSON or a bad shape reads as empty. */
export function readRecentCollections(storage: StorageLike = browserStorage()): RecentCollection[] {
  if (!account) return [];
  try {
    const raw = storage?.getItem(storageKeyFor(account));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecentCollection) : [];
  } catch {
    return [];
  }
}

function write(list: readonly RecentCollection[], storage: StorageLike): void {
  if (!account) return;
  try {
    storage?.setItem(storageKeyFor(account), JSON.stringify(list));
  } catch {
    // Private mode or quota: the current session still works, it just isn't remembered.
  }
}

/** Records a successfully resolved collection at the front of the list. */
export function addRecentCollection(entry: Omit<RecentCollection, 'viewedAt'>, storage: StorageLike = browserStorage()): RecentCollection[] {
  const existing = readRecentCollections(storage);
  const withoutDuplicate = existing.filter((r) => !(r.contract.toLowerCase() === entry.contract.toLowerCase() && r.chainId === entry.chainId));
  const next = [{ ...entry, viewedAt: Date.now() }, ...withoutDuplicate].slice(0, MAX_RECENT);
  write(next, storage);
  return next;
}

export function toRecentCollectionEntry(input: string, resolved: { contract: string; chainId: number; chainName: string; name: string | null; image: { kind: 'external' | 'proxied'; url: string } | null }): Omit<RecentCollection, 'viewedAt'> {
  return {
    input,
    contract: resolved.contract,
    chainId: resolved.chainId,
    chainName: resolved.chainName,
    name: resolved.name,
    // Only an externally-hotlinkable (OpenSea) URL is worth remembering for the dropdown's small
    // preview thumb: a proxied image needs an authenticated fetch, not worth doing for every entry in
    // a list that may never be opened.
    imageUrl: resolved.image?.kind === 'external' ? resolved.image.url : null,
  };
}
