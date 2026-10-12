import type { PublicClient } from 'viem';
import { withTimeout, isRpcTransportFailure } from '@stryx/utils';
import { SimulationRevertedError, RpcUnavailableError } from '../types/errors.js';
import type { TransactionScope, UnsignedTransactionRequest } from '../types/transaction.types.js';

/** Explicit budget for the eth_call: viem's own default retries several times and can run well past its nominal timeout. */
const SIMULATE_TIMEOUT_MS = 8_000;

/**
 * Simulates with eth_call just before signing, so a change in chain state (a stage ending, a sell-out)
 * is caught without spending gas.
 */
export class TransactionSimulator {
  constructor(private readonly client: PublicClient) {}

  async simulate(scope: TransactionScope, tx: UnsignedTransactionRequest): Promise<void> {
    try {
      await withTimeout(
        this.client.call({
          account: scope.walletAddress as `0x${string}`,
          to: tx.to,
          data: tx.data,
          value: tx.value,
        }),
        SIMULATE_TIMEOUT_MS,
        'transaction simulation',
      );
    } catch (cause) {
      // A revert and an unreachable RPC both throw here; only the cause chain tells them apart.
      if (isRpcTransportFailure(cause)) {
        throw new RpcUnavailableError(scope, 'pre-simulation', cause);
      }
      throw new SimulationRevertedError(scope, cause);
    }
  }
}
