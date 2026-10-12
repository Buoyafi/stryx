import { useSyncExternalStore } from 'react';

/**
 * One shared 1-second clock for every ticking phase countdown on the page, instead of each card
 * running its own independent `setInterval`.
 */
const INTERVAL_MS = 1_000;
const listeners = new Set<() => void>();
let now = Date.now();
let intervalId: ReturnType<typeof setInterval> | null = null;
let visibilityListenerAttached = false;

function tick(): void {
  now = Date.now();
  listeners.forEach((listener) => listener());
}

function attachVisibilityListenerOnce(): void {
  if (visibilityListenerAttached || typeof document === 'undefined') return;
  visibilityListenerAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
}

/** Low-level: most callers want useSharedNow() below. Exported for direct (non-React) tests. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  attachVisibilityListenerOnce();
  // Starting fresh (the first subscriber, or the first one after everyone else left): `now` could be
  // stale by however long it's been since the last tick, or since module load if this is the very
  // first subscriber ever.
  if (intervalId === null) {
    tick();
    intervalId = setInterval(tick, INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

/** Low-level: most callers want useSharedNow() below. Exported for direct (non-React) tests. */
export function getSnapshot(): number {
  return now;
}

/** The current time, ticking once a second from the ONE shared interval above. */
export function useSharedNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
