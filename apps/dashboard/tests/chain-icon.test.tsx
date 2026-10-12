// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CHAINS } from '@stryx/chains';
import { viewForChainId } from '@stryx/chain-ui';
import { ChainIcon, ChainTooltip } from '@stryx/chain-ui/react';
import { useChainStatusRows } from '../src/lib/chain-health';

// The network is never needed here. If anything under test tried to fetch, this would fail the test.
const apiRequest = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('unexpected network call');
  }),
);
vi.mock('../src/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/api')>()), apiRequest }));

const testnet = CHAINS.find((c) => c.chainId === 46630)!;
const base = CHAINS.find((c) => c.chainId === 8453)!;

afterEach(() => {
  cleanup();
  apiRequest.mockClear();
});

describe('ChainIcon', () => {
  it('is a real button named after the chain, carrying its id, by default', () => {
    const { getByRole } = render(<ChainIcon chain={base} />);
    const button = getByRole('button', { name: 'Base' });
    expect(button.getAttribute('data-chain-id')).toBe('8453');
    expect(button.querySelector('img')?.getAttribute('src')).not.toMatch(/^https?:\/\//);
  });

  it('shows the T badge on a testnet only', () => {
    expect(render(<ChainIcon chain={testnet} />).container.querySelector('.chain-icon__badge')?.textContent).toBe('T');
    cleanup();
    expect(render(<ChainIcon chain={base} />).container.querySelector('.chain-icon__badge')).toBeNull();
  });

  it('is a decorative, non-focusable span with no tooltip hook when interactive={false} (so it can sit inside a button)', () => {
    const { container } = render(<ChainIcon chain={base} interactive={false} />);
    expect(container.querySelector('button')).toBeNull();
    const span = container.querySelector('.chain-icon')!;
    expect(span.getAttribute('aria-hidden')).toBe('true');
    expect(span.hasAttribute('data-chain-id')).toBe(false);
  });

  it('falls back to two letters for a chain the registry does not have', () => {
    const { container } = render(<ChainIcon chain={viewForChainId(999999, 'Nova Chain')} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.chain-icon__fallback')?.textContent).toBe('NO');
  });
});

function Harness({ qc }: { qc: QueryClient }) {
  return (
    <QueryClientProvider client={qc}>
      <ChainIcon chain={testnet} />
      <Tooltip />
    </QueryClientProvider>
  );
}
function Tooltip() {
  const rows = useChainStatusRows();
  return <ChainTooltip extraRows={rows} />;
}

describe('ChainTooltip in the dashboard', () => {
  function hover(el: Element) {
    const event = new MouseEvent('pointerover', { bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    act(() => {
      el.dispatchEvent(event);
    });
  }

  it('shows registry facts plus what the cache already knows, and never fetches', () => {
    const qc = new QueryClient();
    qc.setQueryData(['chains'], { chains: [{ chainId: 46630, name: 'Robinhood Chain Testnet' }] });
    qc.setQueryData(['health'], { status: 'ok' });
    qc.setQueryData(['balances', 'chain', '46630'], { chainId: 46630, balances: [{ walletId: 'a', error: 'rpc down' }] });

    const { getByRole } = render(<Harness qc={qc} />);
    hover(getByRole('button', { name: 'Robinhood Chain Testnet' }));

    const tip = document.querySelector('.chain-tip')!;
    expect(tip.parentElement).toBe(document.body);
    const text = tip.textContent!;
    for (const part of ['Robinhood Chain Testnet', '46630', 'Testnet', 'ETH', 'Connected', 'Configured', 'Failed']) {
      expect(text, part).toContain(part);
    }
    expect(tip.querySelector('.chain-tip__value--fail')?.textContent).toBe('Failed');
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('omits rows for things not yet known, instead of guessing', () => {
    const { getByRole } = render(<Harness qc={new QueryClient()} />);
    hover(getByRole('button', { name: 'Robinhood Chain Testnet' }));
    const labels = [...document.querySelectorAll('.chain-tip__row dt')].map((n) => n.textContent);
    expect(labels).toEqual(['Chain ID', 'Network', 'Gas token']);
  });

  it('removes its tooltip when the app unmounts it', () => {
    const { getByRole, unmount } = render(<Harness qc={new QueryClient()} />);
    hover(getByRole('button', { name: 'Robinhood Chain Testnet' }));
    expect(document.querySelector('.chain-tip')).not.toBeNull();
    unmount();
    expect(document.querySelector('.chain-tip')).toBeNull();
  });

  it('opens on keyboard focus too', () => {
    const { getByRole } = render(<Harness qc={new QueryClient()} />);
    act(() => getByRole('button', { name: 'Robinhood Chain Testnet' }).focus());
    expect(document.querySelector('.chain-tip')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect((document.querySelector('.chain-tip') as HTMLElement | null)?.hidden ?? true).toBe(true);
  });
});
