// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { DateTimePicker } from '../src/components/DateTimePicker';
import { chooseDateTime, chooseQuick } from './helpers/date-time-picker';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Field(props: { initial?: string; min?: () => number; allowClear?: boolean; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <>
      <DateTimePicker
        aria-label="Runs at"
        value={value}
        onChange={(v) => {
          setValue(v);
          props.onChange?.(v);
        }}
        {...(props.min ? { min: props.min } : {})}
        {...(props.allowClear !== undefined ? { allowClear: props.allowClear } : {})}
      />
      <output data-testid="value">{value}</output>
      <button type="button">Elsewhere</button>
    </>
  );
}
const value = () => screen.getByTestId('value').textContent;
const trigger = () => screen.getByRole('button', { name: /Runs at/ });
const day = (n: number) => [...document.querySelectorAll<HTMLElement>('.dtp__panel .dtp__day')].find((c) => !c.classList.contains('is-outside') && c.textContent === String(n))!;

describe('DateTimePicker', () => {
  it('shows a prompt when empty and the chosen date and time when set', () => {
    render(<Field />);
    expect(trigger().textContent).toBe('Pick a date and time');
    cleanup();
    render(<Field initial="2026-10-07T15:05" />);
    expect(trigger().textContent).toMatch(/Oct.*2026, 15:05$/);
    expect(trigger().getAttribute('aria-label')).toMatch(/^Runs at: .*15:05$/);
  });

  it('opens on the month of the chosen day, with that day marked', () => {
    render(<Field initial="2026-10-07T15:05" />);
    fireEvent.click(trigger());
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByText('October 2026')).toBeTruthy();
    expect(day(7).getAttribute('aria-selected')).toBe('true');
    expect(within(panel).getAllByRole('gridcell')).toHaveLength(42);
    expect(document.activeElement).toBe(day(7));
  });

  it('choosing another day keeps the time', () => {
    render(<Field initial="2026-10-07T15:05" />);
    fireEvent.click(trigger());
    fireEvent.click(day(21));
    expect(value()).toBe('2026-10-21T15:05');
  });

  it('month arrows move the view without changing the value, and a day there is chosen with its month', () => {
    render(<Field initial="2026-10-07T15:05" />);
    chooseDateTime(/Runs at/, { monthsAhead: 3, day: 9 });
    expect(value()).toBe('2027-01-09T15:05');
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(within(screen.getByRole('dialog')).getByText('December 2026')).toBeTruthy();
    expect(value()).toBe('2027-01-09T15:05');
  });

  it('hour and minute change the time only', () => {
    render(<Field initial="2026-10-07T15:05" />);
    chooseDateTime(/Runs at/, { day: 7, hour: 7, minute: 8 });
    expect(value()).toBe('2026-10-07T07:08');
  });

  it('the first day chosen from empty starts five minutes from now, never in the past', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 14, 58, 30));
    render(<Field />);
    fireEvent.click(trigger());
    fireEvent.click(day(7));
    expect(value()).toBe('2026-10-07T15:04');
  });

  it('shortcuts set a time from now, rounded up to the minute', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 23, 50, 1));
    render(<Field />);
    chooseQuick(/Runs at/, 'In 15 min');
    expect(value()).toBe('2026-10-08T00:06');
  });

  it('days before the earliest moment cannot be chosen', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0));
    const onChange = vi.fn();
    render(<Field min={() => Date.now()} onChange={onChange} />);
    fireEvent.click(trigger());
    expect(day(6).getAttribute('aria-disabled')).toBe('true');
    expect(day(7).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(day(6));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(day(8));
    expect(onChange).toHaveBeenCalledWith('2026-10-08T12:05');
  });

  it('says so when the chosen time has already passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0));
    render(<Field initial="2026-10-07T09:00" min={() => Date.now()} />);
    fireEvent.click(trigger());
    expect(screen.getByText('That time has already passed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    chooseQuick(/Runs at/, 'In 1 hour');
    fireEvent.click(trigger());
    expect(screen.queryByText('That time has already passed.')).toBeNull();
  });

  it('arrow keys move by day and week, Page Down by month, Home and End to the ends of the week, Enter chooses', () => {
    render(<Field initial="2026-10-07T15:05" />); // a Wednesday
    fireEvent.click(trigger());
    const grid = screen.getByRole('grid');
    const key = (k: string) => fireEvent.keyDown(document.activeElement ?? grid, { key: k });
    key('ArrowRight');
    expect(document.activeElement).toBe(day(8));
    key('ArrowDown');
    expect(document.activeElement).toBe(day(15));
    key('Home');
    expect(document.activeElement).toBe(day(12)); // Monday
    key('End');
    expect(document.activeElement).toBe(day(18)); // Sunday
    key('PageDown');
    expect(within(screen.getByRole('dialog')).getByText('November 2026')).toBeTruthy();
    expect(document.activeElement).toBe(day(18));
    fireEvent.click(document.activeElement!); // Enter on a button is a click
    expect(value()).toBe('2026-11-18T15:05');
  });

  it('the keys cannot walk to a day before the earliest moment', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0));
    render(<Field min={() => Date.now()} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(day(7));
  });

  it('Escape closes it and returns focus to the field; Done does the same', () => {
    render(<Field initial="2026-10-07T15:05" />);
    fireEvent.click(trigger());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('a press anywhere else closes it; a press inside does not', () => {
    render(<Field initial="2026-10-07T15:05" />);
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByText('October 2026'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Tab stays inside the panel', () => {
    render(<Field initial="2026-10-07T15:05" />);
    fireEvent.click(trigger());
    const done = screen.getByRole('button', { name: 'Done' });
    done.focus();
    fireEvent.keyDown(done, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous month' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(done);
  });

  it('Clear empties an optional field, and is not offered when a value is required', () => {
    render(<Field initial="2026-10-07T15:05" />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(value()).toBe('');
    cleanup();
    render(<Field initial="2026-10-07T15:05" allowClear={false} />);
    fireEvent.click(trigger());
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('names the time zone the times are in', () => {
    render(<Field initial="2026-10-07T15:05" />);
    fireEvent.click(trigger());
    expect(screen.getByText(/^Your time: GMT/)).toBeTruthy();
  });
});
