// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '../src/lib/api';

const WALLET_ID = 'w1';
const ADDRESS = '0x1111111111111111111111111111111111111111';
const KEY = '0x' + 'ab'.repeat(32);

const calls: { path: string; method?: string }[] = [];
let responder: (path: string, method: string | undefined) => unknown = () => {
  throw new Error('unexpected request');
};

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string } = {}) => {
      calls.push({ path, method: options.method });
      return responder(path, options.method);
    }),
  };
});

import { ExportKeyModal } from '../src/components/ExportKeyModal';

function renderModal(onClose = () => {}) {
  return render(<ExportKeyModal walletId={WALLET_ID} address={ADDRESS} onClose={onClose} />);
}

const exportOk = (path: string) => {
  if (path === `/wallets/${WALLET_ID}/export-key`) return { address: ADDRESS, privateKey: KEY };
  throw new Error(`unexpected ${path}`);
};

beforeEach(() => {
  calls.length = 0;
  responder = exportOk;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ExportKeyModal', () => {
  it('warns before anything is fetched', () => {
    renderModal();
    expect(screen.getByText(/Anyone with this key controls this wallet/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('reveals the key after Reveal key', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    expect((await screen.findByTestId('exported-key')).textContent).toBe(KEY);
  });

  it('cannot be closed while the key is on its way: the export is recorded whether or not it was seen', async () => {
    let release: (value: unknown) => void = () => {};
    responder = () => new Promise((resolve) => (release = resolve));
    const onClose = vi.fn();
    renderModal(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));

    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement!); // the backdrop
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => release({ address: ADDRESS, privateKey: KEY }));
    expect((await screen.findByTestId('exported-key')).textContent).toBe(KEY);
  });

  it('asks to confirm identity on step_up_required, then retries the export', async () => {
    let attempts = 0;
    responder = (path) => {
      if (path === '/auth/step-up') return { ok: true };
      attempts += 1;
      if (attempts === 1) throw new ApiError(403, { error: 'step_up_required' });
      return exportOk(path);
    };

    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    await screen.findByText("Confirm it's you");
    fireEvent.change(screen.getByPlaceholderText('API token'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect((await screen.findByTestId('exported-key')).textContent).toBe(KEY);
    expect(attempts).toBe(2);
  });

  it('copies the key to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    await screen.findByTestId('exported-key');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(KEY);
  });

  it('wipes the clipboard a minute after a copy, even with the dialog closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(async (_text: string) => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const view = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    await screen.findByTestId('exported-key');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByText(/the clipboard is wiped 60 seconds after you copy/);
    view.unmount();

    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(writeText).toHaveBeenLastCalledWith('');
  });

  it('wipes the clipboard when the tab is in front again, if the browser refused while it was not', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let refuse = false;
    const writeText = vi.fn(async (_text: string) => {
      if (refuse) throw new Error('Document is not focused');
    });
    Object.assign(navigator, { clipboard: { writeText } });
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    await screen.findByTestId('exported-key');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByText(/the clipboard is wiped/);

    refuse = true;
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(writeText).toHaveBeenCalledTimes(2);

    refuse = false;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(writeText).toHaveBeenCalledTimes(3);
    expect(writeText).toHaveBeenLastCalledWith('');
  });

  it('Escape with the identity prompt open closes the prompt only', async () => {
    responder = () => {
      throw new ApiError(403, { error: 'step_up_required' });
    };
    const onClose = vi.fn();
    renderModal(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    await screen.findByText("Confirm it's you");

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText("Confirm it's you")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter twice in the identity prompt sends one check', async () => {
    let release: (value: unknown) => void = () => {};
    let exports = 0;
    responder = (path) => {
      if (path === '/auth/step-up') return new Promise((resolve) => (release = resolve));
      exports += 1;
      if (exports === 1) throw new ApiError(403, { error: 'step_up_required' });
      return exportOk(path);
    };
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    await screen.findByText("Confirm it's you");
    const input = screen.getByPlaceholderText('API token');
    fireEvent.change(input, { target: { value: 'tok' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(calls.filter((c) => c.path === '/auth/step-up')).toHaveLength(1);

    await act(async () => release({ ok: true }));
    expect((await screen.findByTestId('exported-key')).textContent).toBe(KEY);
    expect(exports).toBe(2);
  });

  it('hides the key after 30 seconds and does not show it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    await screen.findByTestId('exported-key');

    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });

    expect(screen.queryByTestId('exported-key')).toBeNull();
    expect(screen.queryByText(KEY)).toBeNull();
    expect(screen.getByText(/The key is hidden/)).toBeTruthy();
  });

  it('shows a plain message when refused as operator-only', async () => {
    responder = () => {
      throw new ApiError(403, { error: 'operator_only' });
    };
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    await screen.findByText('Key export is only available on the operator dashboard.');
  });
});
