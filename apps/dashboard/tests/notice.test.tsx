// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Notice } from '../src/components/Notice';

afterEach(cleanup);

describe('Notice', () => {
  it('announces an error straight away and everything else politely, and can be told otherwise', () => {
    render(
      <>
        <Notice tone="error">Broke</Notice>
        <Notice tone="warn">Careful</Notice>
        <Notice tone="ok">Done</Notice>
        <Notice tone="info">FYI</Notice>
        <Notice tone="warn" role="note">Noted</Notice>
      </>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Broke');
    expect(screen.getAllByRole('status').map((n) => n.textContent)).toEqual(['Careful', 'Done', 'FYI']);
    expect(screen.getByRole('note').textContent).toBe('Noted');
    expect(document.querySelectorAll('.notice--error, .notice--warn, .notice--ok, .notice--info')).toHaveLength(5);
  });

  it('shows a short message whole, with nothing extra to press', () => {
    render(<Notice>Not enough balance.</Notice>);
    expect(screen.getByText('Not enough balance.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('alert').getAttribute('title')).toBeNull();
  });

  it('cuts a long message to one line, keeps the rest in the tooltip, and opens it on Details', () => {
    const long = `Simulation failed: ${'the contract reverted for a reason that needs a lot of words to explain '.repeat(4)}`;
    render(<Notice>{long}</Notice>);
    const box = screen.getByRole('alert');
    const text = box.querySelector('.notice__text')!;
    expect(text.textContent!.length).toBeLessThanOrEqual(110);
    expect(text.textContent!.endsWith('…')).toBe(true);
    expect(box.getAttribute("title")).toBe(long);
    const more = within(box).getByRole('button', { name: 'Details' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(text.textContent).toBe(long);
    expect(within(box).getByRole('button', { name: 'Less' }).getAttribute('aria-expanded')).toBe('true');
    expect(box.getAttribute('title')).toBeNull();
  });

  it('keeps only the first line of a chain-client error, and never shows a URL', () => {
    render(<Notice>{'HTTP request failed.\n\nURL: https://rpc.example.com/v2/SECRETKEY\nVersion: viem@2'}</Notice>);
    const box = screen.getByRole('alert');
    expect(box.textContent).not.toContain('SECRETKEY');
    expect(box.getAttribute('title')).not.toContain('SECRETKEY');
    fireEvent.click(within(box).getByRole('button', { name: 'Details' }));
    expect(box.textContent).not.toContain('SECRETKEY');
    expect(box.textContent).toContain('[url]');
  });

  it('holds a longer explanation behind Details, and a button that belongs to the message', () => {
    let clicked = 0;
    render(
      <Notice tone="warn" detail="Clock skew was 1.4s." action={<button type="button" onClick={() => clicked++}>Try again</button>}>
        Clock was off.
      </Notice>,
    );
    expect(screen.queryByText('Clock skew was 1.4s.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Clock skew was 1.4s.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(clicked).toBe(1);
  });

  it('takes rich content as it is, without trying to cut it', () => {
    render(
      <Notice>
        Sorry, <b>this</b> failed.
      </Notice>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Sorry, this failed.');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
