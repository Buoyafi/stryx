import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalletPicker } from '../src/components/WalletPicker';
import { balanceKeys } from '../src/lib/balance-cache';

/**
 * Server-rendered (no DOM): these check WIRING: that components read the
 * shared balance keys: which is where the original bug lived. They can't
 * check behaviour that needs effects or clicks (see vitest.config.ts).
 */

const wallets = [
  { id: 'w1', address: `0x${'11'.repeat(20)}`, label: 'source', tier: 'HOT', status: 'ACTIVE' },
  { id: 'w2', address: `0x${'22'.repeat(20)}`, label: 'other', tier: 'HOT', status: 'ACTIVE' },
];

function render(ui: React.ReactElement, seed?: (qc: QueryClient) => void): string {
  const qc = new QueryClient();
  seed?.(qc);
  return renderToString(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('WalletPicker reads its balances from the shared per-chain key', () => {
  it("shows the SELECTED wallet's balance from the cache entry at balanceKeys.chain(chainId)", () => {
    const html = render(
      <WalletPicker wallets={wallets} chainId="46630" selectedId="w1" onSelect={() => undefined} />,
      (qc) =>
        qc.setQueryData(balanceKeys.chain('46630'), {
          balances: [
            { walletId: 'w1', address: wallets[0]!.address, wei: '1500000000000000000', formatted: '1.5' },
            { walletId: 'w2', address: wallets[1]!.address, wei: '0', formatted: '0' },
          ],
        }),
    );

    expect(html).toContain('1.5');
  });

  it('is the SAME entry whether the chain id arrives as a string or the seed used a number: no second, never-refreshed cache entry', () => {
    const html = render(
      <WalletPicker wallets={wallets} chainId="46630" selectedId="w1" onSelect={() => undefined} />,
      (qc) =>
        qc.setQueryData(balanceKeys.chain(46630), {
          balances: [{ walletId: 'w1', address: wallets[0]!.address, wei: '7', formatted: '7.25' }],
        }),
    );

    expect(html).toContain('7.25');
  });

  it('does not pick up data cached under the OLD, separate root: the split that made post-disperse invalidation miss it', () => {
    const html = render(
      <WalletPicker wallets={wallets} chainId="46630" selectedId="w1" onSelect={() => undefined} />,
      (qc) =>
        qc.setQueryData(['wallet-balances', '46630'], {
          balances: [{ walletId: 'w1', address: wallets[0]!.address, wei: '9', formatted: '99.99' }],
        }),
    );

    expect(html).not.toContain('99.99');
  });
});
