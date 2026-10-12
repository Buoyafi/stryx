// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../src/lib/api';

const calls: { path: string; method?: string; body?: unknown }[] = [];
let responder: (path: string, method: string | undefined, body: unknown) => unknown = (path, method) => {
  throw new Error(`unexpected request in test: ${method ?? 'GET'} ${path}`);
};

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      calls.push({ path, method: options.method, body: options.body });
      return responder(path, options.method, options.body);
    }),
  };
});

import { BulkGenerateModal } from '../src/components/BulkGenerateModal';

function renderModal(onGenerated = () => {}) {
  return render(
    <MemoryRouter>
      <BulkGenerateModal onCancel={() => {}} onGenerated={onGenerated} />
    </MemoryRouter>,
  );
}

const wallets = [
  { id: 'w1', address: '0x1111111111111111111111111111111111111a', label: 'Mint-01' },
  { id: 'w2', address: '0x2222222222222222222222222222222222222b', label: 'Mint-02' },
];

beforeEach(() => {
  calls.length = 0;
  sessionStorage.clear();
  responder = (path, method) => {
    throw new Error(`unexpected request in test: ${method ?? 'GET'} ${path}`);
  };
});
afterEach(cleanup);

describe('BulkGenerateModal', () => {
  it('posts count and label prefix to /wallets/bulk, and shows the resulting wallets', async () => {
    responder = (path, method) => {
      if (path === '/wallets/bulk' && method === 'POST') return wallets;
      throw new Error(`unexpected request in test: ${method} ${path}`);
    };
    const onGenerated = vi.fn();
    renderModal(onGenerated);

    const countInput = screen.getByDisplayValue('1');
    fireEvent.change(countInput, { target: { value: '2' } });
    fireEvent.change(screen.getByPlaceholderText(/Mint-01, Mint-02/), { target: { value: 'Mint' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await screen.findByText('2 wallets generated');
    expect(calls[0]).toMatchObject({ path: '/wallets/bulk', method: 'POST', body: { count: 2, labelPrefix: 'Mint' } });
    expect(onGenerated).toHaveBeenCalledOnce();
    expect(screen.getByText('Mint-01')).toBeTruthy();
    expect(screen.getByText('Mint-02')).toBeTruthy();
  });

  it('rejects a count outside 1-100 client-side, without ever calling the API', () => {
    renderModal();
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(screen.getByText('Enter a whole number between 1 and 100.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('shows the backend error message on failure', async () => {
    responder = () => {
      throw new ApiError(500, { error: 'kms_unavailable', message: 'Key management is unreachable.' });
    };
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await screen.findByText('Key management is unreachable.');
  });

  it('"Send to Disperse" writes the sessionStorage handoff with id, address and label', async () => {
    responder = (path, method) => {
      if (path === '/wallets/bulk' && method === 'POST') return wallets;
      throw new Error(`unexpected request in test: ${method} ${path}`);
    };
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('2 wallets generated');

    act(() => screen.getByRole('button', { name: 'Send to Disperse' }).click());

    const stored = JSON.parse(sessionStorage.getItem('stryx.disperse-prefill')!);
    expect(stored).toEqual([
      { id: 'w1', address: '0x1111111111111111111111111111111111111a', label: 'Mint-01' },
      { id: 'w2', address: '0x2222222222222222222222222222222222222b', label: 'Mint-02' },
    ]);
  });

  it('"Download CSV" does not throw (jsdom has no real download, just confirms wiring)', async () => {
    responder = (path, method) => {
      if (path === '/wallets/bulk' && method === 'POST') return wallets;
      throw new Error(`unexpected request in test: ${method} ${path}`);
    };
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('2 wallets generated');

    expect(() => act(() => screen.getByRole('button', { name: 'Download CSV' }).click())).not.toThrow();
  });
});
