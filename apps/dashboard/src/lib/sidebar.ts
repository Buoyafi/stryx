import { useEffect, useState } from 'react';

/** The sidebar's small pieces of logic: the persisted pin, which layout applies, and whether it is expanded. */
export const PIN_STORAGE_KEY = 'stryx-sidebar-pinned';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null;

function browserStorage(): StorageLike {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // touching localStorage can itself throw when storage is blocked
  }
}

export function readPinned(storage: StorageLike = browserStorage()): boolean {
  try {
    return storage?.getItem(PIN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePinned(pinned: boolean, storage: StorageLike = browserStorage()): void {
  try {
    storage?.setItem(PIN_STORAGE_KEY, pinned ? '1' : '0');
  } catch {
    // Private mode or quota: the pin still works for this session, it just is not remembered.
  }
}

/** `rail`: a slim icon rail that expands on hover or focus. `touch`: no hover, so a floating bottom bar instead of a rail. */
export type SidebarLayout = 'rail' | 'touch';

/** No hover (touch) or a narrow window: there is nothing to hover, and no room for a permanent rail. */
export const TOUCH_QUERY = '(hover: none), (max-width: 720px)';

export function layoutFor(matchesTouch: boolean): SidebarLayout {
  return matchesTouch ? 'touch' : 'rail';
}

export function useSidebarLayout(): SidebarLayout {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(TOUCH_QUERY) : null;
  const [layout, setLayout] = useState<SidebarLayout>(() => layoutFor(query?.matches ?? false));
  useEffect(() => {
    if (!query) return;
    const onChange = () => setLayout(layoutFor(query.matches));
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return layout;
}

export interface SidebarInputs {
  layout: SidebarLayout;
  pinned: boolean;
  hovered: boolean;
  focused: boolean;
}

/** Whether the labels are showing. */
export function isExpanded(s: SidebarInputs): boolean {
  return s.layout === 'rail' && (s.pinned || s.hovered || s.focused);
}
