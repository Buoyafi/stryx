import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastQueue, DEFAULT_DURATION_MS, MAX_VISIBLE, type ToastQueue } from '../src/core.js';

describe('createToastQueue', () => {
  let queue: ToastQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = createToastQueue();
  });

  afterEach(() => {
    queue.destroy();
    vi.useRealTimers();
  });

  it('pushes a toast and returns its id', () => {
    const id = queue.push({ tone: 'success', title: 'Saved' });
    expect(queue.getState().visible.map((t) => t.id)).toEqual([id]);
  });

  it('applies each tone default duration', () => {
    const errorId = queue.push({ tone: 'error', title: 'Failed' });
    const successId = queue.push({ tone: 'success', title: 'OK' });
    const infoId = queue.push({ tone: 'info', title: 'FYI' });
    const byId = (id: string) => queue.getState().visible.find((t) => t.id === id)!;
    expect(byId(errorId).durationMs).toBe(DEFAULT_DURATION_MS.error);
    expect(byId(successId).durationMs).toBe(DEFAULT_DURATION_MS.success);
    expect(byId(infoId).durationMs).toBe(DEFAULT_DURATION_MS.info);
  });

  it('an error carrying an action button never auto-dismisses', () => {
    const id = queue.push({ tone: 'error', title: 'OpenSea unavailable', actionLabel: 'Retry', onAction: () => {} });
    expect(queue.getState().visible.find((t) => t.id === id)?.durationMs).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(queue.getState().visible.some((t) => t.id === id)).toBe(true);
  });

  it('a plain success/info toast auto-dismisses after its default duration', () => {
    const id = queue.push({ tone: 'success', title: 'Wallet archived' });
    vi.advanceTimersByTime(DEFAULT_DURATION_MS.success - 1);
    expect(queue.getState().visible.some((t) => t.id === id)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(queue.getState().visible.some((t) => t.id === id)).toBe(false);
  });

  it(`keeps at most ${MAX_VISIBLE} visible, evicting the oldest on a new push`, () => {
    const first = queue.push({ tone: 'info', title: '1' });
    queue.push({ tone: 'info', title: '2' });
    queue.push({ tone: 'info', title: '3' });
    expect(queue.getState().visible).toHaveLength(3);
    const fourth = queue.push({ tone: 'info', title: '4' });
    const ids = queue.getState().visible.map((t) => t.id);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(first);
    expect(ids).toContain(fourth);
  });

  it('dismiss removes a toast immediately and cancels its timer', () => {
    const id = queue.push({ tone: 'success', title: 'X' });
    queue.dismiss(id);
    expect(queue.getState().visible).toHaveLength(0);
    // If the timer weren't cancelled, this would throw on an already-removed toast; it should just no-op.
    vi.advanceTimersByTime(DEFAULT_DURATION_MS.success);
    expect(queue.getState().visible).toHaveLength(0);
  });

  it('dismissing an unknown id is a no-op', () => {
    queue.push({ tone: 'success', title: 'X' });
    expect(() => queue.dismiss('nope')).not.toThrow();
    expect(queue.getState().visible).toHaveLength(1);
  });

  it('pause freezes the countdown and resume continues from where it left off, without drift', () => {
    const id = queue.push({ tone: 'error', title: 'X' }); // 6000ms
    vi.advanceTimersByTime(4000);
    queue.pause(id);
    const paused = queue.getState().visible.find((t) => t.id === id)!;
    expect(paused.paused).toBe(true);
    expect(paused.remainingMs).toBe(2000);

    // Time passes while paused: must not count against the budget.
    vi.advanceTimersByTime(10_000);
    expect(queue.getState().visible.some((t) => t.id === id)).toBe(true);

    queue.resume(id);
    vi.advanceTimersByTime(1999);
    expect(queue.getState().visible.some((t) => t.id === id)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(queue.getState().visible.some((t) => t.id === id)).toBe(false);
  });

  it('pause/resume is a no-op for a toast that never auto-dismisses', () => {
    const id = queue.push({ tone: 'error', title: 'X', actionLabel: 'Retry', onAction: () => {} });
    queue.pause(id);
    queue.resume(id);
    vi.advanceTimersByTime(60_000);
    expect(queue.getState().visible.some((t) => t.id === id)).toBe(true);
  });

  it('multiple pause/resume cycles never drift the remaining time', () => {
    const id = queue.push({ tone: 'success', title: 'X' }); // 3500ms
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      queue.pause(id);
      vi.advanceTimersByTime(5000); // dead time while paused, must never count
      queue.resume(id);
    }
    // 500ms of real countdown time has elapsed across the 5 cycles; 3000ms should remain.
    vi.advanceTimersByTime(2999);
    expect(queue.getState().visible.some((t) => t.id === id)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(queue.getState().visible.some((t) => t.id === id)).toBe(false);
  });

  it('subscribe notifies on push and dismiss, and unsubscribe stops further notifications', () => {
    const fn = vi.fn();
    const unsubscribe = queue.subscribe(fn);
    const id = queue.push({ tone: 'info', title: 'X' });
    expect(fn).toHaveBeenCalledTimes(1);
    queue.dismiss(id);
    expect(fn).toHaveBeenCalledTimes(2);
    unsubscribe();
    queue.push({ tone: 'info', title: 'Y' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('an explicit durationMs override wins over the tone default', () => {
    const id = queue.push({ tone: 'info', title: 'X', durationMs: 1000 });
    expect(queue.getState().visible.find((t) => t.id === id)?.durationMs).toBe(1000);
  });

  it('destroy clears every pending timer', () => {
    queue.push({ tone: 'success', title: 'X' });
    queue.push({ tone: 'info', title: 'Y' });
    queue.destroy();
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
  });
});
