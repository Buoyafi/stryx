// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CopyableValue } from '../src/components/CopyableValue';

const VALUE = '0x1111111111111111111111111111111111111a';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CopyableValue', () => {
  it('without the Clipboard API, copies the full value with the copy command instead of throwing', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    let copiedText = '';
    document.execCommand = vi.fn(() => {
      copiedText = (document.activeElement as HTMLTextAreaElement | null)?.value ?? (document.querySelector('textarea')?.value ?? '');
      return true;
    });

    render(<CopyableValue value={VALUE} />);
    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('✓ copied')).toBeTruthy();
    expect(copiedText).toBe(VALUE);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
