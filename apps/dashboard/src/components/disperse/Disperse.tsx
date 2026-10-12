import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { chainById } from '@stryx/chains';
import { toast } from '@stryx/toast-ui';
import { apiRequest } from '../../lib/api';
import { chargeLogo } from '../../lib/brand';
import { invalidateBalances } from '../../lib/balance-cache';
import { chooseSendMode, signatureWarning, type SendMode } from '../../lib/disperse-plan';
import { allConfirmed, isFinished, sendFromOurWallet, sendSequentially, sendViaContract, type SendItem, type SendTarget } from '../../lib/disperse-send';
import { trackReceipts } from '../../lib/disperse-track';
import { readAndClearDisprefill } from '../../lib/disperse-prefill';
import { validateRecipients, type AmountMode, type RecipientRow } from '../../lib/recipients';
import { shortError } from '../../lib/short-error';
import { WalletError, classifyWalletError, verifyDisperseContract } from '../../lib/wallet';
import { useConnectedWallet, walletConnectStore, type WalletConnectStore } from '../../lib/wallet-connect-store';
import { ChainPicker, type ChainChoice } from './ChainPicker';
import { RecipientsEditor } from './RecipientsEditor';
import { ReviewStep } from './ReviewStep';
import { ChainBanner, ResultsTable, statusCounts } from './ResultsTable';
import { SourcePicker, type OurWallet, type SourceKind } from './SourcePicker';
import { Notice } from '../Notice';
import { DisperseSummary } from './DisperseSummary';

type Step = 'compose' | 'review' | 'run';
type Prepared = { state: 'idle' } | { state: 'working' } | { state: 'ready'; contractVerified: boolean; contractNote: string | null } | { state: 'failed'; message: string };

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const CONTRACT_PROBLEM: Record<'no_code' | 'mismatch' | 'unreadable', string> = {
  no_code: 'The disperse contract was not found on this chain, so plain transfers will be used.',
  mismatch: 'The code at the disperse contract address is not the code that was verified, so plain transfers will be used.',
  unreadable: 'Could not check the disperse contract, so plain transfers will be used.',
};

/** Send native tokens to many addresses. */
export function Disperse(props: {
  mode: 'operator' | 'user';
  chains: readonly ChainChoice[];
  ourWallets?: readonly OurWallet[];
  /** Injected in tests; defaults to the shared app-wide singleton. */
  store?: WalletConnectStore;
}) {
  const { mode, chains } = props;
  const store = props.store ?? walletConnectStore;
  const ourWallets = useMemo(() => (mode === 'operator' ? (props.ourWallets ?? []) : []), [mode, props.ourWallets]);
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('compose');
  const [chainId, setChainId] = useState<number | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>('connected');
  const kind: SourceKind = mode === 'operator' ? sourceKind : 'connected';

  const wallet = useConnectedWallet(store);
  const session = wallet.session;
  const connectedAccount = wallet.status === 'connected' ? wallet.account : null;
  const [ourId, setOurId] = useState('');

  const [rows, setRowsState] = useState<readonly RecipientRow[]>([]);
  const setRows = useCallback((update: (r: readonly RecipientRow[]) => readonly RecipientRow[]) => setRowsState(update), []);
  const [amountMode, setAmountMode] = useState<AmountMode>('same');
  const [sameAmount, setSameAmount] = useState('0.001');

  const [prepared, setPrepared] = useState<Prepared>({ state: 'idle' });
  const [items, setItems] = useState<SendItem[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const started = useRef(false);
  const charged = useRef(false);
  const abort = useRef<AbortController | null>(null);

  const chain = chainId === null ? undefined : chainById(chainId);
  const symbol = chain?.nativeCurrency.symbol ?? '';
  const chainName = chains.find((c) => c.chainId === chainId)?.name ?? chain?.name ?? '';

  useEffect(() => () => abort.current?.abort(), []);

  // A one-shot handoff from a bulk wallet generation, consumed once on mount.
  useEffect(() => {
    if (mode !== 'operator') return;
    const prefill = readAndClearDisprefill();
    if (!prefill || prefill.length === 0) return;
    // The same id the wallet picker gives a wallet ("ours:<id>"): with any other id the picker did not
    // know the wallet was already in the list, and ticking it added it a second time.
    const seen = new Set<string>();
    setRows(() =>
      prefill.flatMap((w) => {
        const id = w.id ? `ours:${w.id}` : `prefill:${w.address.toLowerCase()}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [{ id, source: 'ours' as const, address: w.address, ...(w.label ? { label: w.label } : {}) }];
      }),
    );
  }, [mode, setRows]);

  const ourSource = ourWallets.find((w) => w.id === ourId);
  const sourceAddress = kind === 'connected' ? connectedAccount : (ourSource?.address ?? null);
  const ourSelectable = ourWallets.filter((w) => w.status === 'ACTIVE' && w.id !== (kind === 'ours' ? ourId : ''));

  const validation = useMemo(() => validateRecipients(rows, { sourceAddress, amountMode, sameAmount }), [rows, sourceAddress, amountMode, sameAmount]);

  // A connected wallet has to be on the chosen chain before anything about that chain (its balance,
  // the disperse contract's code, a gas estimate) can be read from it.
  const prepare = useCallback(async () => {
    if (kind !== 'connected' || !session || !connectedAccount || chainId === null) {
      setPrepared({ state: 'idle' });
      return;
    }
    setPrepared({ state: 'working' });
    try {
      if ((await session.chainId()) !== chainId) await session.switchChain(chainId);
      const contract = chain?.disperseContract ?? null;
      if (!contract) return setPrepared({ state: 'ready', contractVerified: false, contractNote: null });
      const check = await verifyDisperseContract(session, contract);
      setPrepared({ state: 'ready', contractVerified: check.ok, contractNote: check.ok ? null : CONTRACT_PROBLEM[check.reason] });
    } catch (err) {
      const e = classifyWalletError(err);
      const message = e.kind === 'unknown_chain' ? `Your wallet does not have ${chainName} yet. Add it in your wallet, then try again.` : e.kind === 'rejected' ? `You declined switching to ${chainName}.` : e.message;
      setPrepared({ state: 'failed', message: shortError(message, 140) });
    }
  }, [kind, session, connectedAccount, chainId, chain, chainName]);
  useEffect(() => {
    void prepare();
  }, [prepare]);

  const sourceKindForPlan = kind === 'connected' ? 'connected' : 'custodial';
  const mode_: SendMode = chain ? chooseSendMode({ chain, sourceKind: sourceKindForPlan, contractVerified: prepared.state === 'ready' && prepared.contractVerified }) : 'sequential';
  const warning = chain && validation.valid.length > 0 ? signatureWarning(mode_, sourceKindForPlan, validation.valid.length) : null;

  const ready = chainId !== null && sourceAddress !== null && validation.canSend && (kind === 'ours' || prepared.state === 'ready');
  const whyNot =
    chainId === null ? 'Pick a chain.' : sourceAddress === null ? (kind === 'connected' ? 'Connect a wallet.' : 'Pick a wallet to send from.') : kind === 'connected' && prepared.state === 'working' ? 'Preparing your wallet…' : kind === 'connected' && prepared.state === 'failed' ? prepared.message : !validation.canSend ? 'Fix the recipients above.' : null;

  const run = async () => {
    if (started.current || !chain || chainId === null || !sourceAddress) return;
    started.current = true;
    charged.current = false;
    setRunError(null);
    setStep('run');
    const targets: SendTarget[] = validation.valid.map((v) => ({ address: v.address, wei: v.wei }));
    setItems(targets.map((t) => ({ ...t, status: 'waiting' })));
    abort.current = new AbortController();
    try {
      let final: SendItem[];
      if (kind === 'connected' && session) {
        // The wallet may have been switched to another network since the review: never send on the wrong one.
        if ((await session.chainId()) !== chainId) throw new WalletError('other', `Your wallet is no longer on ${chainName}. Switch back and start again.`);
        const input = { session, from: sourceAddress, targets, onUpdate: setItems, signal: abort.current.signal, chainId };
        final = mode_ === 'contract' && chain.disperseContract ? await sendViaContract({ ...input, contract: chain.disperseContract }) : await sendSequentially(input);
      } else {
        final = await sendFromOurWallet({
          request: (path, body) => apiRequest(path, { method: 'POST', body }),
          sourceWalletId: ourId,
          chainId,
          targets,
          track: (id, hashes, onReceipt) => trackReceipts(id, hashes, onReceipt, { signal: abort.current?.signal }),
          onUpdate: setItems,
        });
      }
      setItems(final);
      if (kind === 'ours') {
        const ids = new Set(rows.filter((r) => r.source === 'ours').map((r) => r.id.replace('ours:', '')));
        void invalidateBalances(queryClient, { chainId, walletIds: [ourId, ...ids] });
      }
    } catch (err) {
      const message = shortError(err instanceof Error ? classifyWalletError(err).message : 'The send failed.', 140);
      setRunError(message);
      setItems((cur) => cur.map((i) => (i.status === 'waiting' || i.status === 'signing' ? { ...i, status: 'not_sent', error: message } : i)));
    }
  };

  // The logo charges once, when every recipient has confirmed.
  useEffect(() => {
    if (step === 'run' && !charged.current && allConfirmed(items)) {
      charged.current = true;
      chargeLogo();
    }
  }, [step, items]);

  const finished = step === 'run' && items.length > 0 && isFinished(items);
  const counts = statusCounts(items);

  // One ambient summary toast when the batch actually finishes; the counts line and ResultsTable above
  // stay as the durable per-recipient record, never toasted per-item.
  const toastedFinishRef = useRef(false);
  useEffect(() => {
    if (finished && !toastedFinishRef.current) {
      toastedFinishRef.current = true;
      const failedCount = counts.failed + counts.not_sent;
      if (runError) toast.error('Disperse failed', runError);
      else if (failedCount > 0) toast.success('Disperse complete', `${counts.confirmed} confirmed, ${failedCount} failed`);
      else toast.success('Disperse complete', `${counts.confirmed} confirmed`);
    }
    if (!finished) toastedFinishRef.current = false;
  }, [finished, runError, counts.confirmed, counts.failed, counts.not_sent]);

  const again = () => {
    started.current = false;
    setItems([]);
    setRunError(null);
    setRowsState([]);
    setStep('compose');
    void prepare();
  };

  if (step === 'review' && chain && chainId !== null && sourceAddress) {
    return (
      <section className="dsp-card dsp-card--wide" aria-label="Review">
        <div className="dsp-card__head">
          <h2>Review before sending</h2>
        </div>
        <ReviewStep
          chain={{ chainId, name: chainName, symbol }}
          source={{ kind: sourceKindForPlan, address: sourceAddress, ...(kind === 'ours' && ourSource?.label ? { label: ourSource.label } : {}), ...(kind === 'ours' ? { walletId: ourId } : {}) }}
          mode={mode_}
          contract={chain.disperseContract}
          recipients={validation.valid}
          totalWei={validation.totalWei}
          session={kind === 'connected' ? session : null}
          onBack={() => setStep('compose')}
          onConfirm={() => void run()}
        />
      </section>
    );
  }

  if (step === 'run' && chainId !== null) {
    return (
      <section className="dsp-card dsp-card--wide" aria-label="Results">
        <div className="dsp-card__head">
          <h2>{finished ? 'Finished' : 'Sending'}</h2>
        </div>
        <ChainBanner chainId={chainId} name={chainName} />
        <p role="status" style={{ margin: '12px 0', fontSize: 12.5 }}>
          {counts.confirmed} confirmed{counts.pending + counts.signing > 0 ? `, ${counts.pending + counts.signing} in progress` : ''}
          {counts.failed > 0 ? `, ${counts.failed} failed` : ''}
          {counts.unconfirmed > 0 ? `, ${counts.unconfirmed} unconfirmed` : ''}
          {counts.not_sent > 0 ? `, ${counts.not_sent} not sent` : ''}.
        </p>
        {runError && (
          <Notice tone="error">
            {runError}
          </Notice>
        )}
        <ResultsTable items={items} chainId={chainId} symbol={symbol} />
        {finished && (
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={again}>
              Start another
            </button>
          </div>
        )}
      </section>
    );
  }

  const sourceLabel = kind === 'ours' ? (ourSource ? (ourSource.label ?? shortAddr(ourSource.address)) : null) : connectedAccount ? shortAddr(connectedAccount) : null;
  const stepDone = { chain: chainId !== null, source: sourceAddress !== null };

  return (
    <div className="dsp">
      <div className="dsp__main">
        <section className="dsp-card" aria-label="Chain">
          <div className="dsp-card__head">
            <span className={`dsp-step${stepDone.chain ? ' is-done' : ''}`} aria-hidden="true">1</span>
            <h2>Chain</h2>
            {symbol && <small>Gas token: {symbol}</small>}
          </div>
          {chains.length === 0 ? <span style={{ color: 'var(--stryx-sub)' }}>No chains available.</span> : <ChainPicker chains={chains} value={chainId} onChange={setChainId} />}
        </section>

        <section className="dsp-card" aria-label="Source">
          <div className="dsp-card__head">
            <span className={`dsp-step${stepDone.source ? ' is-done' : ''}`} aria-hidden="true">2</span>
            <h2>Send from</h2>
          </div>
          <SourcePicker
            mode={mode}
            kind={kind}
            onKind={setSourceKind}
            store={store}
            chainId={chainId}
            symbol={symbol}
            ourWallets={ourWallets}
            ourId={ourId}
            onOurChange={setOurId}
          />
          {kind === 'connected' && connectedAccount && chainId !== null && prepared.state === 'working' && <p style={{ color: 'var(--stryx-sub)', fontSize: 12, marginTop: 8 }}>Switching your wallet to {chainName}…</p>}
          {kind === 'connected' && prepared.state === 'failed' && (
            <Notice
              tone="error"
              action={
                <button type="button" onClick={() => void prepare()}>
                  Try again
                </button>
              }
            >
              {prepared.message}
            </Notice>
          )}
        </section>

        <section className="dsp-card" aria-label="Recipients">
          <div className="dsp-card__head">
            <span className="dsp-step" aria-hidden="true">3</span>
            <h2>Recipients</h2>
            <small>{rows.length} added</small>
          </div>
          <RecipientsEditor mode={mode} rows={rows} setRows={setRows} validation={validation} amountMode={amountMode} setAmountMode={setAmountMode} sameAmount={sameAmount} setSameAmount={setSameAmount} ourSelectable={ourSelectable} symbol={symbol} chainId={chainId} />
        </section>
      </div>

      <DisperseSummary
        chainName={chainName}
        symbol={symbol}
        from={sourceLabel}
        recipients={validation.valid.length}
        each={amountMode === 'same' ? sameAmount.trim() : null}
        totalWei={validation.totalWei}
        ready={ready}
        whyNot={whyNot}
        onReview={() => setStep('review')}
      >
        {warning && (
          <Notice tone="warn" role="note" compact>
            {warning}
          </Notice>
        )}
        {kind === 'connected' && prepared.state === 'ready' && prepared.contractNote && (
          <Notice tone="warn" compact>
            {prepared.contractNote}
          </Notice>
        )}
      </DisperseSummary>
    </div>
  );
}
