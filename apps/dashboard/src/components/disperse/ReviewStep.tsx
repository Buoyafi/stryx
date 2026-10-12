import { useEffect, useState } from 'react';
import type { DisperseContract } from '@stryx/chains';
import { DISPERSE_CONTRACT_NOTE } from '@stryx/chains';
import { apiRequest } from '../../lib/api';
import { encodeDisperseEther } from '../../lib/disperse-abi';
import { estimateGas, reviewNumbers, type SendMode, type SourceKind } from '../../lib/disperse-plan';
import { formatWei } from '../../lib/units';
import type { WalletSession } from '../../lib/wallet';
import { ChainBanner } from './ResultsTable';
import { Notice } from '../Notice';

const short = (v: string) => `${v.slice(0, 8)}…${v.slice(-6)}`;

export interface ReviewProps {
  chain: { chainId: number; name: string; symbol: string };
  source: { kind: SourceKind; address: string; label?: string; walletId?: string };
  mode: SendMode;
  contract: DisperseContract | null;
  recipients: readonly { address: string; wei: bigint }[];
  totalWei: bigint;
  session: WalletSession | null;
  onBack: () => void;
  onConfirm: () => void;
}

const GAS_BASIS = { exact: 'exact: plain transfers cost 21,000 gas each', estimated: 'estimated by your wallet', rough: 'a rough, generous guess (your wallet could not estimate it)' } as const;

/** The last screen before anything is signed or sent. */
export function ReviewStep(props: ReviewProps) {
  const { chain, source, mode, contract, recipients, totalWei, session } = props;
  const [balanceWei, setBalanceWei] = useState<bigint | undefined>();
  const [gasPriceWei, setGasPriceWei] = useState<bigint | undefined>();
  const [walletEstimate, setWalletEstimate] = useState<bigint | undefined>();
  const [loading, setLoading] = useState(true);
  const [readErrors, setReadErrors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const errors: string[] = [];
    (async () => {
      if (source.kind === 'connected' && session) {
        const [balance, price] = await Promise.allSettled([session.balance(source.address), session.gasPrice()]);
        if (cancelled) return;
        if (balance.status === 'fulfilled') setBalanceWei(balance.value); else errors.push('Could not read your balance.');
        if (price.status === 'fulfilled') setGasPriceWei(price.value); else errors.push('Could not read the gas price.');
        if (mode === 'contract' && contract) {
          try {
            const est = await session.estimateGas({ from: source.address, to: contract.address, value: totalWei, data: encodeDisperseEther(recipients.map((r) => r.address), recipients.map((r) => r.wei)) });
            if (!cancelled) setWalletEstimate(est);
          } catch {
            /* the rough estimate is used and labelled */
          }
        }
      } else if (source.kind === 'custodial' && source.walletId) {
        const [balances, price] = await Promise.allSettled([
          apiRequest<{ balances: { chainId: number; wei: string; error?: string }[] }>(`/wallets/${source.walletId}/balances?chainId=${chain.chainId}`),
          apiRequest<{ gasPriceWei: string }>(`/chains/${chain.chainId}/gas-price`),
        ]);
        if (cancelled) return;
        const mine = balances.status === 'fulfilled' ? balances.value.balances.find((b) => b.chainId === chain.chainId) : undefined;
        if (mine && !mine.error) setBalanceWei(BigInt(mine.wei));
        else errors.push(mine?.error ?? 'Could not read the wallet balance.');
        if (price.status === 'fulfilled') setGasPriceWei(BigInt(price.value.gasPriceWei)); else errors.push('Could not read the gas price.');
      }
      if (!cancelled) {
        setReadErrors(errors);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source.kind, source.address, source.walletId, chain.chainId, mode, contract, session, totalWei, recipients]);

  const gas = estimateGas({ mode, recipients: recipients.length, walletEstimate });
  const numbers = reviewNumbers({ totalWei, gasUnits: gas.units, gasPriceWei, balanceWei });
  const symbol = chain.symbol;

  return (
    <div>
      <ChainBanner chainId={chain.chainId} name={chain.name} />

      <dl className="review-facts">
        <dt>From</dt>
        <dd className="mono">
          {source.label ? `${source.label} ` : ''}
          {short(source.address)} ({source.kind === 'connected' ? 'connected wallet' : 'Stryx wallet'})
        </dd>
        <dt>How</dt>
        <dd>
          {mode === 'contract'
            ? 'One transaction through the disperse contract. It is all or nothing: every recipient is paid, or none.'
            : recipients.length === 1
              ? 'One transaction.'
              : source.kind === 'connected'
                ? `${recipients.length} separate transactions, one per recipient. You will sign ${recipients.length} times.`
                : `${recipients.length} separate transactions, sent one after another from your Stryx wallet.`}
        </dd>
        <dt>Total to send</dt>
        <dd className="mono review-facts__strong">
          {formatWei(totalWei)} {symbol}
        </dd>
        <dt>Estimated gas</dt>
        <dd className="mono">
          {loading ? 'Reading…' : `${gas.units.toString()} units`}
          {!loading && numbers.gasCostWei !== undefined && `, about ${formatWei(numbers.gasCostWei)} ${symbol}`}
          {!loading && numbers.gasCostWei === undefined && ', price unknown'}
          {!loading && <div className="review-facts__note">{GAS_BASIS[gas.basis]}</div>}
        </dd>
        <dt>Balance now</dt>
        <dd className="mono">{loading ? 'Reading…' : balanceWei === undefined ? 'unknown' : `${formatWei(balanceWei)} ${symbol}`}</dd>
        <dt>Left after sending</dt>
        <dd className="mono review-facts__strong">
          {loading ? 'Reading…' : numbers.remainingWei === undefined ? 'unknown' : `${formatWei(numbers.remainingWei)} ${symbol}`}
        </dd>
      </dl>

      {!loading && !numbers.enough && (
        <Notice tone="error">
          Not enough balance to cover the amount{numbers.gasCostWei !== undefined ? ' and gas' : ''}.
        </Notice>
      )}
      {readErrors.map((e) => (
        <Notice key={e} tone="warn">
          {e}
        </Notice>
      ))}
      {mode === 'contract' && (
        <p className="review-contract">
          Contract {contract?.address}. {DISPERSE_CONTRACT_NOTE}
        </p>
      )}

      <table className="dense review-recipients" aria-label="Recipients to pay">
        <thead>
          <tr>
            <th>#</th>
            <th>Recipient</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {recipients.map((r, i) => (
            <tr key={r.address}>
              <td className="mono review-recipients__n">{i + 1}</td>
              <td className="mono review-recipients__address">{r.address}</td>
              <td className="mono review-recipients__amount">
                {formatWei(r.wei)} {symbol}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="review-actions">
        <button type="button" onClick={props.onBack}>
          Back
        </button>
        <button type="button" className="primary" disabled={loading || !numbers.enough} onClick={props.onConfirm}>
          Confirm and send
        </button>
        <span className="review-actions__note">Nothing is sent until you press this.</span>
      </div>
    </div>
  );
}
