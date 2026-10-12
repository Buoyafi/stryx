// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MintResultsView } from '../src/components/mint/MintResultsView';
import type { MintFireRow } from '../src/lib/mint-fire';

afterEach(cleanup);

const ROWS: MintFireRow[] = [
  { walletId: 'w1', address: '0x1111111111111111111111111111111111111a', status: 'sent', quantity: 1, hash: '0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1' },
  { walletId: 'w2', address: '0x2222222222222222222222222222222222222b', status: 'failed', quantity: 1, detail: 'Not enough funds.' },
  { walletId: 'w3', address: '0x3333333333333333333333333333333333333c', status: 'skipped', quantity: 0, detail: 'Halted: daily spending cap. Remaining wallets skipped.' },
];

describe('MintResultsView', () => {
  it('shows the success count out of the total', () => {
    render(<MintResultsView rows={ROWS} chainId={46630} onClose={vi.fn()} />);
    expect(screen.getByText('1/3 wallets succeeded.')).toBeTruthy();
  });

  it('shows a status pill and detail text per wallet', () => {
    render(<MintResultsView rows={ROWS} chainId={46630} onClose={vi.fn()} />);
    expect(screen.getByText('sent')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('skipped')).toBeTruthy();
    expect(screen.getByText('Not enough funds.')).toBeTruthy();
  });

  it('links a transaction hash to the block explorer when the chain has one', () => {
    render(<MintResultsView rows={ROWS} chainId={46630} onClose={vi.fn()} />);
    const link = screen.getByTitle(ROWS[0]!.hash!) as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.href).toBeTruthy();
  });

  it('shows a scheduled row with a pending-style pill, not a hash', () => {
    const scheduled: MintFireRow[] = [{ walletId: 'w1', address: '0x1111111111111111111111111111111111111a', status: 'scheduled', quantity: 1, detail: 'Scheduled (job abc).' }];
    render(<MintResultsView rows={scheduled} chainId={46630} onClose={vi.fn()} />);
    expect(screen.getByText('scheduled')).toBeTruthy();
    expect(screen.getByText('Scheduled (job abc).')).toBeTruthy();
  });

  it('shortens a raw, unclassified chain-client error into one short line, keeping the full text in the title (a wallet failing at broadcast, not simulation, could reach this column as a raw multi-paragraph dump)', () => {
    const rawDetail = 'Missing or invalid parameters. Double check you have provided the correct parameters.\nURL: http://rpc.example\nRequest body: {"method":"eth_sendRawTransaction"}\nDetails: insufficient funds for gas * price + value: address 0xCCE608C5872A77f06155B2665675a755710A1101 have 0 want 1701084000000\nVersion: viem@2.55.11';
    const rows: MintFireRow[] = [{ walletId: 'w1', address: '0x1111111111111111111111111111111111111a', status: 'failed', quantity: 1, detail: rawDetail }];
    render(<MintResultsView rows={rows} chainId={46630} onClose={vi.fn()} />);
    const cell = document.querySelector('td:last-child') as HTMLTableCellElement;
    expect(cell.title).toBe(rawDetail); // the FULL raw text stays available on hover
    expect(cell.textContent!.length).toBeLessThan(70);
    expect(cell.textContent).not.toContain('Request body');
    expect(cell.textContent).not.toContain('viem@2.55.11');
  });

  it('calls onClose from the Done button', () => {
    const onClose = vi.fn();
    render(<MintResultsView rows={ROWS} chainId={46630} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
