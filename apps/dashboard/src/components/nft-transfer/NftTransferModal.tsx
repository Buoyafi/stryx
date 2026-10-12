import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chainById } from '@stryx/chains';
import { toast } from '@stryx/toast-ui';
import { apiRequest } from '../../lib/api';
import { tokenKey, transferNfts, type NftTransferItemInput, type NftTransferOutcome } from '../../lib/nft-transfer';
import { Dropdown } from '../Dropdown';
import { HoldingsPicker } from './HoldingsPicker';
import { TransferReviewStep } from './TransferReviewStep';
import { TransferResultsView } from './TransferResultsView';
import { Notice } from '../Notice';
import { useEscapeToClose } from '../../lib/useEscapeToClose';

interface WalletLite {
  id: string;
  address: string;
  label: string | null;
  status: string;
}

type Step = 'compose' | 'review' | 'results';

/** "Transfer NFTs": select wallets, see what each holds, pick some or all, send to one destination. */
export function NftTransferModal({
  onCancel,
  onTransferred,
  initialWalletId,
}: {
  onCancel: () => void;
  onTransferred: () => void;
  /** Pre-checks one wallet when opened from that wallet's row. */
  initialWalletId?: string;
}) {
  const [step, setStep] = useState<Step>('compose');
  const [chainId, setChainId] = useState<number | null>(null);
  const [checkedWallets, setCheckedWallets] = useState<ReadonlySet<string>>(
    () => new Set(initialWalletId ? [initialWalletId] : []),
  );
  const [selected, setSelected] = useState<ReadonlyMap<string, NftTransferItemInput>>(new Map());
  const [destination, setDestination] = useState('');
  const [outcome, setOutcome] = useState<NftTransferOutcome | null>(null);

  const { data: chainsData } = useQuery({
    queryKey: ['chains'],
    queryFn: () => apiRequest<{ chains: { chainId: number; name: string }[] }>('/chains'),
  });
  const { data: wallets } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => apiRequest<WalletLite[]>('/wallets'),
  });

  const toggleWallet = (id: string) => {
    // Unticking a wallet hides its tokens, so it must also unselect them: nothing unseen is sent.
    if (checkedWallets.has(id)) setSelected((prev) => new Map([...prev].filter(([, item]) => item.walletId !== id)));
    setCheckedWallets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleToken = (item: NftTransferItemInput) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const key = tokenKey(item);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  };

  const setWalletSelection = (items: readonly NftTransferItemInput[], select: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const item of items) {
        const key = tokenKey(item);
        if (select) next.set(key, item);
        else next.delete(key);
      }
      return next;
    });
  };

  const items = [...selected.values()].filter((item) => checkedWallets.has(item.walletId));
  const sourceWallets = (wallets ?? []).filter((w) => checkedWallets.has(w.id));

  const queryClient = useQueryClient();
  const transfer = useMutation({
    mutationFn: () => transferNfts(chainId!, destination.trim(), items),
    onSuccess: (result) => {
      // Whatever was sent must not still be offered as held.
      void queryClient.invalidateQueries({ queryKey: ['nft-holdings'] });
      setOutcome(result);
      setStep('results');
      onTransferred();
      const sentCount = result.results.filter((r) => r.status === 'sent').length;
      const unknownCount = result.results.filter((r) => r.status === 'unknown').length;
      const notSent = result.results.length - sentCount - unknownCount;
      if (unknownCount > 0) toast.error('Check before retrying', `${unknownCount} may have been sent`);
      else if (sentCount === result.results.length) toast.success('Transfer complete', `${sentCount} sent`);
      else if (sentCount === 0) toast.error('Transfer failed', `${result.results.length} items failed`);
      else toast.success('Transfer complete', `${sentCount} sent, ${notSent} failed`);
    },
  });

  const symbol = chainId !== null ? (chainById(chainId)?.nativeCurrency.symbol ?? '') : '';

  useEscapeToClose(step === 'compose' ? onCancel : undefined);

  return (
    <div className="modal-backdrop" onClick={step === 'compose' ? onCancel : undefined}>
      <div className="modal stryx-scroll" style={{ width: 720, maxHeight: '85vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        {step === 'compose' && (
          <>
            <h2 style={{ fontSize: 15, marginBottom: 8 }}>Transfer NFTs</h2>
            <p style={{ color: 'var(--stryx-sub)', fontSize: 12.5, marginBottom: 14 }}>
              Select wallets to see what each holds, then pick which tokens to move.
            </p>

            <label style={{ display: 'block', fontSize: 12, color: 'var(--stryx-sub)', marginBottom: 4 }}>Chain</label>
            <div style={{ marginBottom: 16 }}>
              <Dropdown
                aria-label="Chain"
                options={(chainsData?.chains ?? []).map((c) => ({ value: String(c.chainId), label: c.name }))}
                value={chainId !== null ? String(chainId) : ''}
                onChange={(v) => {
                  setChainId(v ? Number(v) : null);
                  setSelected(new Map());
                }}
              />
            </div>

            {chainId !== null && (
              <HoldingsPicker
                wallets={wallets ?? []}
                chainId={chainId}
                checkedWallets={checkedWallets}
                onToggleWallet={toggleWallet}
                selected={selected}
                onToggleToken={toggleToken}
                onSetWalletSelection={setWalletSelection}
              />
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={onCancel}>Cancel</button>
              <button className="primary" onClick={() => setStep('review')} disabled={chainId === null || items.length === 0}>
                Review {items.length > 0 ? `(${items.length})` : ''}
              </button>
            </div>
          </>
        )}

        {step === 'review' && chainId !== null && (
          <>
            <h2 style={{ fontSize: 15, marginBottom: 8 }}>Review transfer</h2>
            <TransferReviewStep
              chainId={chainId}
              symbol={symbol}
              items={items}
              sourceWallets={sourceWallets}
              destination={destination}
              onDestinationChange={setDestination}
              confirming={transfer.isPending}
              onBack={() => setStep('compose')}
              onConfirm={() => transfer.mutate()}
            />
            {transfer.isError && (
              <Notice tone="error">{transfer.error instanceof Error ? transfer.error.message : 'Could not reach the API.'}</Notice>
            )}
          </>
        )}

        {step === 'results' && chainId !== null && outcome && (
          <>
            <h2 style={{ fontSize: 15, marginBottom: 8 }}>Transfer results</h2>
            <TransferResultsView chainId={chainId} results={outcome.results} onClose={onCancel} />
          </>
        )}
      </div>
    </div>
  );
}
