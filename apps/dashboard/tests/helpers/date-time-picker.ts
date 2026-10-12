import { fireEvent, screen, within } from '@testing-library/react';

/**
 * Drives a DateTimePicker the way a person does: opens it by its label, moves `monthsAhead` months on,
 * picks `day`, sets the time if given, and closes it.
 */
export function chooseDateTime(label: RegExp, choice: { monthsAhead?: number; day: number; hour?: number; minute?: number }): void {
  fireEvent.click(screen.getByRole('button', { name: label }));
  const panel = screen.getByRole('dialog');
  for (let i = 0; i < (choice.monthsAhead ?? 0); i++) fireEvent.click(within(panel).getByRole('button', { name: 'Next month' }));
  const cell = [...panel.querySelectorAll<HTMLElement>('.dtp__day')].find((c) => !c.classList.contains('is-outside') && c.textContent === String(choice.day));
  if (!cell) throw new Error(`no day ${choice.day} in the month shown`);
  fireEvent.click(cell);
  const setTime = (name: 'Hour' | 'Minute', n: number) => {
    fireEvent.click(within(panel).getByRole('combobox', { name }));
    fireEvent.mouseDown(within(panel).getByRole('option', { name: String(n).padStart(2, '0') }));
  };
  if (choice.hour !== undefined) setTime('Hour', choice.hour);
  if (choice.minute !== undefined) setTime('Minute', choice.minute);
  fireEvent.click(within(panel).getByRole('button', { name: 'Done' }));
}

/** Opens a DateTimePicker and presses one of its shortcuts ("In 5 min", "In 15 min", "In 1 hour"). */
export function chooseQuick(label: RegExp, shortcut: string): void {
  fireEvent.click(screen.getByRole('button', { name: label }));
  const panel = screen.getByRole('dialog');
  fireEvent.click(within(panel).getByRole('button', { name: shortcut }));
  fireEvent.click(within(panel).getByRole('button', { name: 'Done' }));
}
