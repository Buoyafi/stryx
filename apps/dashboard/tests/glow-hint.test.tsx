// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GlowHint } from '../src/components/GlowHint';

afterEach(cleanup);

describe('GlowHint', () => {
  it('renders a focusable, labelled status button with the icon and text', () => {
    render(<GlowHint visible text="Add at least one recipient to continue" />);
    const el = screen.getByRole('status', { name: 'Add at least one recipient to continue' });
    expect(el.tagName).toBe('BUTTON');
    expect(el.textContent).toContain('Add at least one recipient to continue');
  });

  it('uses a custom icon when given one', () => {
    render(<GlowHint visible text="Pick a chain first" icon="→" />);
    expect(screen.getByText('→')).not.toBeNull();
  });

  it('calls onActivate when clicked', () => {
    const onActivate = vi.fn();
    render(<GlowHint visible text="Add at least one recipient to continue" onActivate={onActivate} />);
    fireEvent.click(screen.getByRole('status'));
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it('renders nothing when visible is false from the start', () => {
    render(<GlowHint visible={false} text="Add at least one recipient to continue" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('fades out and is removed from the DOM after visible flips to false', async () => {
    const { rerender } = render(<GlowHint visible text="Add at least one recipient to continue" />);
    expect(screen.getByRole('status')).not.toBeNull();

    rerender(<GlowHint visible={false} text="Add at least one recipient to continue" />);
    // Still present immediately (mid-exit-transition), then gone once the ~200ms timer fires.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 1000 });
  });

  it('reappears if visible flips back to true after disappearing', async () => {
    const { rerender } = render(<GlowHint visible text="Add at least one recipient to continue" />);
    rerender(<GlowHint visible={false} text="Add at least one recipient to continue" />);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 1000 });

    rerender(<GlowHint visible text="Add at least one recipient to continue" />);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeNull());
  });
});
