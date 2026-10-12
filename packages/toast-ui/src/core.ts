export type ToastTone = 'error' | 'success' | 'info';

export interface ToastInput {
  tone: ToastTone;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Overrides the tone's default auto-dismiss time. `null` means never auto-dismiss. */
  durationMs?: number | null;
}

export interface ToastRecord extends ToastInput {
  id: string;
  durationMs: number | null;
  /** ms left before auto-dismiss, frozen while paused. `null` means it never auto-dismisses. */
  remainingMs: number | null;
  /** When the countdown last (re)started, for computing elapsed time on pause. */
  resumedAt: number;
  paused: boolean;
}

export interface ToastQueueState {
  visible: readonly ToastRecord[];
}

export const MAX_VISIBLE = 3;

export const DEFAULT_DURATION_MS: Record<ToastTone, number> = {
  error: 6000,
  success: 3500,
  info: 3500,
};

let counter = 0;
function nextId(): string {
  counter += 1;
  return `toast-${counter}`;
}

/** An error carrying an action button stays until dismissed, per spec, unless the caller overrides it. */
function resolveDuration(input: ToastInput): number | null {
  if (input.durationMs !== undefined) return input.durationMs;
  if (input.tone === 'error' && (input.actionLabel !== undefined || input.onAction !== undefined)) return null;
  return DEFAULT_DURATION_MS[input.tone];
}

export interface ToastQueue {
  push(input: ToastInput): string;
  dismiss(id: string): void;
  /** Freezes the auto-dismiss countdown (hover/focus on the pill). */
  pause(id: string): void;
  /** Unfreezes it, continuing from wherever it was frozen, not from the start. */
  resume(id: string): void;
  subscribe(fn: (state: ToastQueueState) => void): () => void;
  getState(): ToastQueueState;
  /** Clears every pending timer. Does not clear listeners; call once, when the host unmounts. */
  destroy(): void;
}

/**
 * Framework-free toast state: at most MAX_VISIBLE visible, per-tone durations, and pause/resume
 * tracked as a remaining-ms budget.
 */
export function createToastQueue(): ToastQueue {
  let visible: ToastRecord[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(state: ToastQueueState) => void>();

  function getState(): ToastQueueState {
    return { visible };
  }

  function notify(): void {
    const state = getState();
    for (const fn of listeners) fn(state);
  }

  function clearTimer(id: string): void {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
  }

  function scheduleTimer(record: ToastRecord): void {
    clearTimer(record.id);
    if (record.remainingMs === null || record.paused) return;
    const handle = setTimeout(() => dismiss(record.id), record.remainingMs);
    timers.set(record.id, handle);
  }

  function push(input: ToastInput): string {
    const id = nextId();
    const durationMs = resolveDuration(input);
    const record: ToastRecord = {
      ...input,
      id,
      durationMs,
      remainingMs: durationMs,
      resumedAt: Date.now(),
      paused: false,
    };
    visible = [...visible, record];
    if (visible.length > MAX_VISIBLE) {
      const oldest = visible[0];
      if (oldest) clearTimer(oldest.id);
      visible = visible.slice(1);
    }
    scheduleTimer(record);
    notify();
    return id;
  }

  function dismiss(id: string): void {
    if (!visible.some((t) => t.id === id)) return;
    clearTimer(id);
    visible = visible.filter((t) => t.id !== id);
    notify();
  }

  function pause(id: string): void {
    const idx = visible.findIndex((t) => t.id === id);
    const record = idx === -1 ? undefined : visible[idx];
    if (idx === -1 || !record || record.paused || record.remainingMs === null) return;
    const elapsed = Date.now() - record.resumedAt;
    const updated: ToastRecord = { ...record, paused: true, remainingMs: Math.max(0, record.remainingMs - elapsed) };
    clearTimer(id);
    visible = visible.map((t, i) => (i === idx ? updated : t));
    notify();
  }

  function resume(id: string): void {
    const idx = visible.findIndex((t) => t.id === id);
    const record = idx === -1 ? undefined : visible[idx];
    if (idx === -1 || !record || !record.paused || record.remainingMs === null) return;
    const updated: ToastRecord = { ...record, paused: false, resumedAt: Date.now() };
    visible = visible.map((t, i) => (i === idx ? updated : t));
    scheduleTimer(updated);
    notify();
  }

  function subscribe(fn: (state: ToastQueueState) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function destroy(): void {
    for (const id of timers.keys()) clearTimer(id);
    visible = [];
  }

  return { push, dismiss, pause, resume, subscribe, getState, destroy };
}
