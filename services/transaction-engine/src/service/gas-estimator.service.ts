import type { PublicClient } from 'viem';
import { withTimeout, isRpcTransportFailure } from '@stryx/utils';
import { RpcUnavailableError, SimulationRevertedError } from '../types/errors.js';
import type { TransactionScope, UnsignedTransactionRequest, GasParameters, ExecuteOptions } from '../types/transaction.types.js';

/**
 * Multiplier applied to the raw gas estimate: a live estimate can undershoot slightly by the time the
 * tx actually lands, and an out-of-gas revert still costs the gas spent.
 */
const GAS_BUFFER_NUMERATOR = 120n;
const GAS_BUFFER_DENOMINATOR = 100n;

/** Same explicit-budget reasoning as TransactionSimulator's SIMULATE_TIMEOUT_MS: see that file. */
const ESTIMATE_TIMEOUT_MS = 8_000;

/** Turns a node's fee suggestion into the fees actually sent, applying an operator's chosen tip and the chain's minimum tip. */
export function applyPriorityFee(
  suggested: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  opts: { priorityFeeWei?: bigint | undefined; minPriorityFeeWei?: bigint | null | undefined },
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  let tip = opts.priorityFeeWei ?? suggested.maxPriorityFeePerGas;
  if (opts.minPriorityFeeWei != null && tip < opts.minPriorityFeeWei) tip = opts.minPriorityFeeWei;
  if (tip === suggested.maxPriorityFeePerGas) return suggested;
  const basePart = suggested.maxFeePerGas > suggested.maxPriorityFeePerGas ? suggested.maxFeePerGas - suggested.maxPriorityFeePerGas : 0n;
  return { maxFeePerGas: basePart + tip, maxPriorityFeePerGas: tip };
}

export class GasEstimator {
  /** `minPriorityFeeWei`: the chain's own minimum tip, or null. */
  constructor(
    private readonly client: PublicClient,
    private readonly minPriorityFeeWei: bigint | null = null,
    private readonly gasBufferPercent: bigint = GAS_BUFFER_NUMERATOR,
  ) {}

  async estimate(scope: TransactionScope, tx: UnsignedTransactionRequest, options: ExecuteOptions = {}): Promise<GasParameters> {
    let rawGas: bigint;
    let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    try {
      [rawGas, fees] = await withTimeout(
        Promise.all([
          this.client.estimateGas({
            account: scope.walletAddress as `0x${string}`,
            to: tx.to,
            data: tx.data,
            value: tx.value,
          }),
          this.client.estimateFeesPerGas(),
        ]),
        ESTIMATE_TIMEOUT_MS,
        'gas estimation',
      );
    } catch (cause) {
      if (isRpcTransportFailure(cause)) {
        throw new RpcUnavailableError(scope, 'gas-estimation', cause);
      }
      // `estimateGas` fails the same way `eth_call` does if the transaction would revert, and it runs
      // first, so a doomed transaction is caught here.
      throw new SimulationRevertedError(scope, cause);
    }

    const priced = applyPriorityFee(fees, { priorityFeeWei: options.priorityFeeWei, minPriorityFeeWei: this.minPriorityFeeWei });
    return {
      gas: (rawGas * this.gasBufferPercent) / GAS_BUFFER_DENOMINATOR,
      maxFeePerGas: priced.maxFeePerGas,
      maxPriorityFeePerGas: priced.maxPriorityFeePerGas,
    };
  }
}
