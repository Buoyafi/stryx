// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@stryx/toast-ui', () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn(async () => {
      throw new actual.ApiError(409, { message: 'That name is already taken.' });
    }),
  };
});

const { EditableName } = await import('../src/components/EditableName');

afterEach(cleanup);

describe('EditableName', () => {
  it('a failed rename says so, and keeps the field open with what was typed', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
        <EditableName walletId="w1" label="Old" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename wallet' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Rename failed', 'That name is already taken.'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Taken');
  });
});
