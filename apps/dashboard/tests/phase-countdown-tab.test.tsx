// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PhaseCountdownTab } from '../src/components/mint/PhaseCountdownTab';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PhaseCountdownTab', () => {
  it('ticks down to the second, every second, on its own', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    render(<PhaseCountdownTab startMs={null} endMs={now + 90_000} />);

    expect(screen.getByText('Live · ends in 1m 30s')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('Live · ends in 1m 29s')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('Live · ends in 1m 28s')).not.toBeNull();
  });

  it('transitions upcoming -> live at exactly the start timestamp, with no prop change', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    render(<PhaseCountdownTab startMs={now + 5_000} endMs={now + 65_000} />);

    expect(screen.getByText('Starts in 5s')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(screen.getByText('Starts in 1s')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText(/^Live · ends in/)).not.toBeNull();
  });

  it('transitions live -> ended the tick after the end timestamp (boundary inclusive: still live exactly at it)', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    render(<PhaseCountdownTab startMs={now - 60_000} endMs={now + 3_000} />);

    expect(screen.getByText(/^Live · ends in/)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(3_000); // lands exactly on endMs
    });
    expect(screen.getByText(/^Live · ends in/)).not.toBeNull(); // still live at the boundary itself

    act(() => {
      vi.advanceTimersByTime(1_000); // one tick past it
    });
    expect(screen.getByText('Ended')).not.toBeNull();
  });

  it('renders a plain placeholder when neither timestamp is known', () => {
    render(<PhaseCountdownTab startMs={null} endMs={null} />);
    expect(screen.getByText('Phase')).not.toBeNull();
  });

  it('several tabs mounted together all tick from the same shared clock', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    render(
      <>
        <PhaseCountdownTab startMs={null} endMs={now + 90_000} />
        <PhaseCountdownTab startMs={now + 10_000} endMs={now + 70_000} />
      </>,
    );

    expect(screen.getByText('Live · ends in 1m 30s')).not.toBeNull();
    expect(screen.getByText('Starts in 10s')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText('Live · ends in 1m 29s')).not.toBeNull();
    expect(screen.getByText('Starts in 9s')).not.toBeNull();
  });
});
