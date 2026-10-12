// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuantityStepper } from '../src/components/QuantityStepper';

afterEach(cleanup);

function Harness({ max = 50, start = 1 }: { max?: number; start?: number }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <QuantityStepper value={value} onChange={setValue} isMax={false} onToggleMax={() => {}} max={max} />
      <output data-testid="committed">{value}</output>
    </>
  );
}

const field = () => screen.getByLabelText('Quantity per wallet') as HTMLInputElement;
const committed = () => Number(screen.getByTestId('committed').textContent);

describe('QuantityStepper', () => {
  it('can be cleared and retyped: clearing 1 and typing 5 gives 5, not 15', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: '' } });
    expect(field().value).toBe('');
    fireEvent.change(field(), { target: { value: '5' } });
    expect(field().value).toBe('5');
    expect(committed()).toBe(5);
  });

  it('a number past the limit is brought into range when the field is left, not while typing', () => {
    render(<Harness max={3} />);
    fireEvent.change(field(), { target: { value: '2' } });
    expect(committed()).toBe(2);
    fireEvent.change(field(), { target: { value: '25' } });
    expect(committed()).toBe(2); // out of range: not taken yet
    fireEvent.blur(field());
    expect(field().value).toBe('3');
    expect(committed()).toBe(3);
  });

  it('leaving the field empty puts the last number back', () => {
    render(<Harness start={4} />);
    fireEvent.change(field(), { target: { value: '' } });
    fireEvent.blur(field());
    expect(field().value).toBe('4');
    expect(committed()).toBe(4);
  });

  it('the buttons still step within the limits', () => {
    render(<Harness max={2} />);
    fireEvent.click(screen.getByLabelText('Increase quantity'));
    expect(committed()).toBe(2);
    expect((screen.getByLabelText('Increase quantity') as HTMLButtonElement).disabled).toBe(true);
  });
});
