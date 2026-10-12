import { parseUnits, formatUnits } from 'viem';
import { chainById } from './chain-registry.js';
import type { WalletService, UserId } from '@stryx/wallet-service';
import {
  BroadcastUncertainError,
  EmergencyStopActiveError,
  SimulationRevertedError,
  SpendingCapExceededError,
  RpcUnavailableError,
} from '@stryx/transaction-engine';
import type { ChainServices } from './chain-services.js';
import { chainErrorText } from './chain-error-text.js';
import type { SpendCapResolver } from './spend-cap-resolver.js';

export interface DisperseRecipient {
  /** Destination address. */
  address: `0x${string}`;
  /** Amount in the chain's own token (e.g. "0.01" ETH, "2" BNB), per its registry decimals. Converted to wei internally. */
  amount: string;
}

export interface DisperseResult {
  address: string;
  amount: string;
  /** 'unknown': the send call failed and the chain could not say whether it went out. Check `hash` before sending again. */
  status: 'sent' | 'failed' | 'unknown';
  hash?: string;
  nonce?: number;
  error?: string;
}

export interface DisperseOutcome {
  ok: boolean;
  /** Set when the whole operation was rejected before ANY transfer was attempted. */
  preflightError?: 'unsupported_chain' | 'insufficient_balance' | 'no_recipients' | 'zero_amount' | 'chain_unreachable';
  /** Set when the batch was halted part way by a stop, a cap or an unreachable chain. */
  haltReason?: 'spending_cap_exceeded' | 'emergency_stop' | 'rpc_unavailable';
  detail?: string;
  results: DisperseResult[];
  totalSentWei: string;
}

/**
 * Sends native tokens from one wallet to many: funding mint wallets with gas. Transfers go one at a
 * time, each through the full transaction engine, and the batch halts on a stop, a cap or an
 * unreachable chain.
 */
export class DisperseService {
  constructor(
    private readonly walletService: WalletService,
    private readonly chainServices: Map<number, ChainServices>,
    private readonly spendCapResolver: SpendCapResolver,
  ) {}

  async disperse(params: {
    ownerId: UserId;
    sourceWalletId: string;
    chainId: number;
    recipients: readonly DisperseRecipient[];
  }): Promise<DisperseOutcome> {
    const { ownerId, sourceWalletId, chainId, recipients } = params;

    if (recipients.length === 0) {
      return { ok: false, preflightError: 'no_recipients', results: [], totalSentWei: '0' };
    }

    const chain = this.chainServices.get(chainId);
    if (!chain) {
      return {
        ok: false,
        preflightError: 'unsupported_chain',
        detail: `chainId=${chainId} has no RPC configured.`,
        results: [],
        totalSentWei: '0',
      };
    }

    const source = await this.walletService.getWalletSummary(ownerId, sourceWalletId);
    const sourceAddress = source.address as `0x${string}`;
    // Resolved once: the cap does not change mid-batch, and each transfer still reserves against
    // today's total.
    const spendCapWei = await this.spendCapResolver.resolve(ownerId, chainId);
    const walletSpendCapWei = this.spendCapResolver.walletCap(spendCapWei);

    // --- Pre-flight: can the source actually cover this? ---
    const amounts = recipients.map((r) => parseUnits(r.amount, chainById(chainId)?.nativeCurrency.decimals ?? 18));
    const totalAmount = amounts.reduce((sum, a) => sum + a, 0n);

    // A transfer of nothing still costs gas, and sending one is never what was meant.
    const zero = recipients.find((_, i) => amounts[i] === 0n);
    if (zero) {
      return { ok: false, preflightError: 'zero_amount', detail: `The amount for ${zero.address} is zero. Give every recipient an amount above zero, or remove it.`, results: [], totalSentWei: '0' };
    }

    let balance: bigint;
    let fees: { maxFeePerGas: bigint };
    try {
      [balance, fees] = await Promise.all([
        chain.publicClient.getBalance({ address: sourceAddress }),
        chain.publicClient.estimateFeesPerGas(),
        // If earlier sends from this wallet were dropped, its nonce counter is ahead of the chain and
        // these would queue behind them.
        chain.transactionEngine.warmNonce({ chainId, walletAddress: sourceAddress }).catch(() => undefined),
      ]);
    } catch (err) {
      // Nothing was sent. Said plainly, not as a bare server error.
      return { ok: false, preflightError: 'chain_unreachable', detail: `Could not read the chain, so nothing was sent: ${chainErrorText(err)}`, results: [], totalSentWei: '0' };
    }

    // What one transfer costs here, asked of the chain.
    const PLAIN_TRANSFER_GAS = 21_000n;
    const gasPerTransfer = await Promise.resolve()
      .then(() => chain.publicClient.estimateGas({ account: sourceAddress, to: recipients[0]!.address, value: amounts[0]! }))
      .then((gas) => (gas > PLAIN_TRANSFER_GAS ? (gas * 11n) / 10n : PLAIN_TRANSFER_GAS))
      .catch(() => PLAIN_TRANSFER_GAS);
    const estimatedGasCost = gasPerTransfer * fees.maxFeePerGas * BigInt(recipients.length);
    const required = totalAmount + estimatedGasCost;

    const currency = chainById(chainId)?.nativeCurrency ?? { symbol: '', decimals: 18 };
    const fmt = (wei: bigint) => `${formatUnits(wei, currency.decimals)} ${currency.symbol}`.trim();
    if (balance < required) {
      return {
        ok: false,
        preflightError: 'insufficient_balance',
        detail: `Source wallet holds ${fmt(balance)} but needs ~${fmt(required)} (${fmt(totalAmount)} to send + ~${fmt(estimatedGasCost)} estimated gas).`,
        results: [],
        totalSentWei: '0',
      };
    }

    // --- Send sequentially ---
    const results: DisperseResult[] = [];
    let totalSent = 0n;
    let haltReason: DisperseOutcome['haltReason'];

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i]!;
      const amountWei = amounts[i]!;

      try {
        const tx = await chain.transactionEngine.executeTransaction(
          { chainId, walletId: sourceWalletId, walletAddress: sourceAddress, ownerId, spendCapWei, walletSpendCapWei },
          { to: recipient.address, data: '0x', value: amountWei },
        );
        results.push({
          address: recipient.address,
          amount: recipient.amount,
          status: 'sent',
          hash: tx.hash,
          nonce: tx.nonce,
        });
        totalSent += amountWei;
      } catch (err) {
        if (err instanceof BroadcastUncertainError) {
          results.push({ address: recipient.address, amount: recipient.amount, status: 'unknown', hash: err.hash, nonce: err.nonce, error: 'May have been sent. Check it before sending again.' });
          continue;
        }
        const message =
          err instanceof EmergencyStopActiveError
            ? `Emergency stop active (stage: ${err.stage})`
            : err instanceof SpendingCapExceededError
              ? `Daily spending cap exceeded: ${err.message}`
              : err instanceof RpcUnavailableError
                ? `Chain unreachable: ${err.message}`
                : err instanceof SimulationRevertedError
                  ? `Simulation reverted: ${err.message}`
                  : chainErrorText(err);

        results.push({ address: recipient.address, amount: recipient.amount, status: 'failed', error: message });

        // A stop, the spending cap or an unreachable RPC all mean stop: every later transfer would hit
        // the same wall.
        if (
          err instanceof EmergencyStopActiveError ||
          err instanceof SpendingCapExceededError ||
          err instanceof RpcUnavailableError
        ) {
          haltReason =
            err instanceof SpendingCapExceededError
              ? 'spending_cap_exceeded'
              : err instanceof RpcUnavailableError
                ? 'rpc_unavailable'
                : 'emergency_stop';
          const skipReason =
            err instanceof SpendingCapExceededError
              ? 'Skipped: daily spending cap reached'
              : err instanceof RpcUnavailableError
                ? 'Skipped: chain was unreachable'
                : 'Skipped: emergency stop halted the batch';
          for (let j = i + 1; j < recipients.length; j++) {
            const skipped = recipients[j]!;
            results.push({
              address: skipped.address,
              amount: skipped.amount,
              status: 'failed',
              error: skipReason,
            });
          }
          break;
        }
      }
    }

    return {
      ok: results.every((r) => r.status === 'sent'),
      ...(haltReason ? { haltReason } : {}),
      results,
      totalSentWei: totalSent.toString(),
    };
  }
}
