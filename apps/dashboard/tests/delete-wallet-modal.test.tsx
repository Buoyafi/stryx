// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DeletionCheck } from '../src/components/DeleteWalletModal';

const api = { check: null as DeletionCheck | null, calls: [] as string[], deleteGate: null as Promise<void> | null };

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, init?: { method?: string }) => {
      api.calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/deletion')) return api.check;
      if (init?.method === 'DELETE') return api.deleteGate ?? undefined;
      throw new Error(`unexpected ${path}`);
    }),
  };
});

const { DeleteWalletModal } = await import('../src/components/DeleteWalletModal');

const base: DeletionCheck = { canDelete: true, reason: 'empty', message: 'Nothing on any chain.', funds: [], keyElsewhere: null, scheduled: 0 };

function open(check: Partial<DeletionCheck>, onCancel = () => {}) {
  api.check = { ...base, ...check };
  const onDeleted = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DeleteWalletModal walletId="w1" address={'0x' + 'a'.repeat(40)} label="Old one" onCancel={onCancel} onDeleted={onDeleted} />
    </QueryClientProvider>,
  );
  return { onDeleted };
}

afterEach(() => {
  cleanup();
  api.calls = [];
  api.deleteGate = null;
});

describe('DeleteWalletModal', () => {
  it('an empty wallet deletes with one press', async () => {
    const { onDeleted } = open({});
    expect(await screen.findByText(/Nothing on any chain/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete wallet' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(api.calls).toContain('DELETE /wallets/w1');
  });

  it('a funded imported wallet asks for the saved key first, then sends that confirmation', async () => {
    const { onDeleted } = open({ canDelete: false, reason: 'confirm_key', keyElsewhere: 'imported', funds: [{ chainName: 'Base', amount: '0.005' }], message: 'It still holds 0.005 on Base. Confirm you have that key saved.' });
    expect(await screen.findByText('0.005')).toBeTruthy();
    const del = screen.getByRole('button', { name: 'Delete wallet' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I have this wallet’s private key saved/ }));
    expect(del.disabled).toBe(false);
    fireEvent.click(del);
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(api.calls).toContain('DELETE /wallets/w1?keySaved=true');
  });

  it('a funded wallet whose only key is in Stryx offers no delete, only what to do first', async () => {
    open({ canDelete: false, reason: 'has_funds', funds: [{ chainName: 'Base', amount: '0.005' }], message: 'Move the funds out first, or export its key, then delete it.' });
    expect(await screen.findByText(/Move the funds out first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete wallet' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('a wallet a scheduled mint uses says to cancel it first', async () => {
    open({ canDelete: false, reason: 'scheduled', scheduled: 1, message: 'A scheduled mint uses this wallet. Cancel it in Activity first.' });
    expect(await screen.findByText(/Cancel it in Activity first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete wallet' })).toBeNull();
  });

  it('a click outside does not close the dialog while the delete is in flight', async () => {
    let finish!: () => void;
    api.deleteGate = new Promise<void>((r) => (finish = r));
    const onCancel = vi.fn();
    open({}, onCancel);
    const del = await screen.findByRole('button', { name: 'Delete wallet' });
    await waitFor(() => expect((del as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(del);
    await screen.findByRole('button', { name: 'Deleting…' });

    fireEvent.click(document.querySelector('.modal-backdrop')!);
    expect(onCancel).not.toHaveBeenCalled();
    finish();
  });
});
