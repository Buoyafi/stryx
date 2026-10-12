// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountToastHost, type ToastHostController } from '../src/dom.js';

describe('mountToastHost', () => {
  let controller: ToastHostController;

  const host = () => document.querySelector<HTMLElement>('.toast-host');
  const pills = () => Array.from(document.querySelectorAll<HTMLElement>('.toast-pill'));

  beforeEach(() => {
    vi.useFakeTimers();
    controller = mountToastHost();
  });

  afterEach(() => {
    controller.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('appends one aria-live region to <body>', () => {
    expect(host()?.parentElement).toBe(document.body);
    expect(host()?.getAttribute('aria-live')).toBe('polite');
    expect(host()?.getAttribute('aria-atomic')).toBe('false');
  });

  it('renders a pill with role=alert for an error and role=status for success/info', () => {
    controller.push({ tone: 'error', title: 'Failed' });
    controller.push({ tone: 'success', title: 'Saved' });
    controller.push({ tone: 'info', title: 'FYI' });
    const roles = pills().map((p) => p.getAttribute('role'));
    expect(roles).toEqual(['alert', 'status', 'status']);
  });

  it('shows the tone dot, dismiss button and message', () => {
    controller.push({ tone: 'success', title: 'Wallet archived', detail: '0x1234...abcd' });
    const pill = pills()[0]!;
    expect(pill.dataset.tone).toBe('success');
    expect(pill.querySelector('.toast-dot')).not.toBeNull();
    const dismiss = pill.querySelector<HTMLButtonElement>('.toast-dismiss')!;
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss');
    expect(pill.querySelector('.toast-text strong')?.textContent).toBe('Wallet archived');
    expect(pill.querySelector('.toast-text span')?.textContent).toBe('0x1234...abcd');
    expect(pill.querySelector('.toast-text')?.getAttribute('title')).toBe('Wallet archived: 0x1234...abcd');
  });

  it('never uses innerHTML with raw text, so a hostile title cannot inject markup', () => {
    controller.push({ tone: 'info', title: '<img src=x onerror=alert(1)>' });
    const pill = pills()[0]!;
    expect(pill.querySelectorAll('img')).toHaveLength(0);
    expect(pill.querySelector('.toast-text strong')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('clicking the dismiss button removes the toast', () => {
    controller.push({ tone: 'success', title: 'X' });
    pills()[0]!.querySelector<HTMLButtonElement>('.toast-dismiss')!.click();
    vi.advanceTimersByTime(200); // exit animation
    expect(pills()).toHaveLength(0);
  });

  it('Escape on a focused toast dismisses only that one', () => {
    const first = controller.push({ tone: 'success', title: 'First' });
    controller.push({ tone: 'success', title: 'Second' });
    const firstPill = pills().find((p) => p.querySelector('.toast-text')?.textContent?.includes('First'))!;
    firstPill.querySelector<HTMLButtonElement>('.toast-dismiss')!.focus();
    firstPill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(pills()).toHaveLength(1);
    expect(pills()[0]!.querySelector('.toast-text')?.textContent).toContain('Second');
    void first;
  });

  it('renders an action button only when both actionLabel and onAction are given', () => {
    const onAction = vi.fn();
    controller.push({ tone: 'error', title: 'OpenSea unavailable', actionLabel: 'Retry', onAction });
    controller.push({ tone: 'error', title: 'No action here' });
    const [withAction, withoutAction] = pills();
    const actionBtn = withAction!.querySelector<HTMLButtonElement>('.toast-action');
    expect(actionBtn?.textContent).toBe('Retry');
    actionBtn!.click();
    expect(onAction).toHaveBeenCalledOnce();
    expect(withoutAction!.querySelector('.toast-action')).toBeNull();
  });

  it('hides the progress line for an action-carrying error (it never auto-dismisses)', () => {
    controller.push({ tone: 'error', title: 'X', actionLabel: 'Retry', onAction: () => {} });
    const progress = pills()[0]!.querySelector<HTMLElement>('.toast-progress')!;
    expect(progress.style.display).toBe('none');
  });

  it('a new toast does not restart the bars of the ones already showing', () => {
    controller.push({ tone: 'success', title: 'First' });
    const firstBar = pills()[0]!.querySelector<HTMLElement>('.toast-progress')!;
    firstBar.style.animation = 'marker';
    vi.advanceTimersByTime(1_000);
    controller.push({ tone: 'success', title: 'Second' });
    expect(firstBar.style.animation).toBe('marker');
  });

  it('a 4th toast evicts the oldest, with an exit animation', () => {
    controller.push({ tone: 'info', title: '1' });
    controller.push({ tone: 'info', title: '2' });
    controller.push({ tone: 'info', title: '3' });
    controller.push({ tone: 'info', title: '4' });
    // Immediately after eviction, the 4-pill count briefly includes the exiting node.
    expect(pills().map((p) => p.querySelector('.toast-text')?.textContent)).toContain('1');
    vi.advanceTimersByTime(200);
    const remaining = pills().map((p) => p.querySelector('.toast-text')?.textContent);
    expect(remaining).toEqual(['2', '3', '4']);
  });

  it('destroy removes the host and stops rendering', () => {
    controller.push({ tone: 'success', title: 'X' });
    controller.destroy();
    expect(host()).toBeNull();
  });
});
