// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module holds singleton state (`activeController`), so every test gets a fresh module instance
// via resetModules + a dynamic re-import.
async function freshModule() {
  vi.resetModules();
  return import('../src/index.js');
}

describe('toast service singleton', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('a toast.* call before any host is mounted is queued, not dropped', async () => {
    const { toast, mountToastHost } = await freshModule();
    toast.success('Wallet archived');
    expect(document.querySelectorAll('.toast-pill')).toHaveLength(0);

    const controller = mountToastHost();
    expect(document.querySelectorAll('.toast-pill')).toHaveLength(1);
    expect(document.querySelector('.toast-text strong')?.textContent).toBe('Wallet archived');
    controller.destroy();
  });

  it('a toast.* call after mounting renders immediately', async () => {
    const { toast, mountToastHost } = await freshModule();
    const controller = mountToastHost();
    toast.error('Could not load wallets', 'Try signing out and back in.');
    expect(document.querySelector('.toast-text strong')?.textContent).toBe('Could not load wallets');
    controller.destroy();
  });

  it('destroy un-registers the host, so a later call queues again instead of throwing', async () => {
    const { toast, mountToastHost } = await freshModule();
    const controller = mountToastHost();
    controller.destroy();
    expect(() => toast.info('X')).not.toThrow();
    expect(document.querySelectorAll('.toast-pill')).toHaveLength(0);
  });

  it('remounting after destroy flushes anything queued in between', async () => {
    const { toast, mountToastHost } = await freshModule();
    const first = mountToastHost();
    first.destroy();
    toast.success('Queued while unmounted');
    const second = mountToastHost();
    expect(document.querySelector('.toast-text strong')?.textContent).toBe('Queued while unmounted');
    second.destroy();
  });

  it('toast.dismiss removes the named toast via the active host', async () => {
    const { toast, mountToastHost } = await freshModule();
    const controller = mountToastHost();
    controller.push({ tone: 'info', title: 'A' });
    const id = controller.push({ tone: 'info', title: 'B' });
    toast.dismiss(id);
    expect(document.querySelectorAll('.toast-pill')).toHaveLength(2); // exit animation still running
    controller.destroy();
  });

  it('toast.dismiss before any host is mounted is a safe no-op', async () => {
    const { toast } = await freshModule();
    expect(() => toast.dismiss('nope')).not.toThrow();
  });
});
