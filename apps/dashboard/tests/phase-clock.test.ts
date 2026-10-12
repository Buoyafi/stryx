// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot, subscribe } from '../src/lib/phase-clock';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('phase-clock: one shared 1-second interval, not one per subscriber', () => {
  it('starts no interval until the first subscriber, and notifies it every second', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const listener = vi.fn();

    const unsubscribe = subscribe(listener);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]![1]).toBe(1_000);
    expect(listener).toHaveBeenCalledTimes(1); // one immediate notify on subscribe, so a fresh mount is never stale

    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3_000);
    expect(listener).toHaveBeenCalledTimes(5);

    unsubscribe();
  });

  it('a second subscriber does NOT start a second interval: both are notified by the same tick', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const a = vi.fn();
    const b = vi.fn();

    const unsubA = subscribe(a);
    const unsubB = subscribe(b);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1); // still just the one, from the first subscriber

    vi.advanceTimersByTime(1_000);
    expect(a).toHaveBeenCalledTimes(2); // 1 immediate (on subscribe) + 1 from the shared tick
    expect(b).toHaveBeenCalledTimes(1); // b joined after the immediate notify, so just the shared tick

    unsubA();
    unsubB();
  });

  it('getSnapshot reflects the real time as of the last tick, updated on each one, and is never stale on a fresh subscribe', () => {
    vi.setSystemTime(1_000_000);
    const unsubscribe = subscribe(() => {});
    expect(getSnapshot()).toBe(1_000_000); // subscribing itself forces an immediate recompute

    vi.setSystemTime(1_001_000);
    vi.advanceTimersByTime(1_000); // advancing fake timers also advances the mocked clock itself
    expect(getSnapshot()).toBe(1_002_000);

    unsubscribe();
  });

  it('clears the underlying interval once the last subscriber unsubscribes (no leaked timer)', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const a = vi.fn();
    const b = vi.fn();

    const unsubA = subscribe(a);
    const unsubB = subscribe(b);
    unsubA();
    expect(clearIntervalSpy).not.toHaveBeenCalled(); // b is still subscribed
    unsubB();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('a later subscriber, after everyone else unsubscribed, gets a fresh interval', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const first = subscribe(() => {});
    first();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    const second = subscribe(() => {});
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    second();
  });
});

describe('phase-clock: recomputes immediately when the tab becomes visible again', () => {
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('a visibilitychange to "visible" notifies subscribers immediately, without waiting for the next tick', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    listener.mockClear();

    setVisibility('hidden');
    expect(listener).not.toHaveBeenCalled(); // going hidden is not itself a reason to recompute

    setVisibility('visible');
    expect(listener).toHaveBeenCalledTimes(1); // recomputed the instant it's foregrounded, no tick needed

    unsubscribe();
  });

  it('the recompute uses the REAL current time, catching up from whatever a throttled background tab missed', () => {
    vi.setSystemTime(2_000_000);
    const unsubscribe = subscribe(() => {});

    // The tab was backgrounded long enough that its (throttled) interval fell far behind.
    vi.setSystemTime(2_090_000); // 90 real seconds later, simulating heavy background throttling
    setVisibility('visible');

    expect(getSnapshot()).toBe(2_090_000); // caught up instantly, not stuck near 2_000_000

    unsubscribe();
  });
});
