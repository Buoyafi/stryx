// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dropdown } from '../src/components/Dropdown';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

function renderDropdown(value = '', onChange = vi.fn()) {
  const utils = render(<Dropdown options={OPTIONS} value={value} onChange={onChange} aria-label="Test dropdown" />);
  return { ...utils, onChange };
}

afterEach(cleanup);

describe('Dropdown', () => {
  it('shows the placeholder when nothing is selected, and the selected label otherwise', () => {
    renderDropdown();
    expect(screen.getByRole('combobox').textContent).toContain('Select…');
    cleanup();
    renderDropdown('b');
    expect(screen.getByRole('combobox').textContent).toContain('Beta');
  });

  it('opens the listbox on click', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Alpha' })).toBeTruthy();
  });

  it('opens on Enter, Space, ArrowDown and ArrowUp when closed', () => {
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp']) {
      renderDropdown();
      fireEvent.keyDown(screen.getByRole('combobox'), { key });
      expect(screen.queryByRole('listbox')).toBeTruthy();
      cleanup();
    }
  });

  it('selecting an option calls onChange with its value and closes the panel', () => {
    const onChange = vi.fn();
    renderDropdown('', onChange);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Beta' }));

    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('ArrowDown moves the highlighted option, Enter commits it', () => {
    const onChange = vi.fn();
    renderDropdown('a', onChange);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger); // opens with 'a' (index 0) highlighted
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // -> index 1 ('b')
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('Escape closes the panel and focus stays on the trigger (never moved into the listbox)', () => {
    renderDropdown();
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeTruthy();

    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('type-ahead jumps the highlight to the first option starting with the typed letter, then Enter selects it', () => {
    const onChange = vi.fn();
    renderDropdown('', onChange);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'g' }); // jumps to 'Gamma'
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('closes when clicking outside', () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <Dropdown options={OPTIONS} value="" onChange={() => {}} aria-label="Test dropdown" />
      </div>,
    );
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId('outside'));

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('sets aria-activedescendant to the highlighted option\'s id while open, and clears it while closed', () => {
    renderDropdown('b');
    const trigger = screen.getByRole('combobox');
    expect(trigger.getAttribute('aria-activedescendant')).toBeNull();

    fireEvent.click(trigger);
    const activeId = trigger.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId!)?.textContent).toBe('Beta');
  });
});
