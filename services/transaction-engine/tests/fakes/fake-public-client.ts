import { CallExecutionError, EstimateGasExecutionError, ExecutionRevertedError, RpcRequestError, TimeoutError, TransactionNotFoundError } from 'viem';

/** The chain viem builds for a genuine revert: the raw JSON-RPC error is the revert error's cause. */
function realRevertChain(): ExecutionRevertedError {
  const rpcErr = new RpcRequestError({
    body: {},
    url: 'http://rpc.example',
    error: { code: 3, message: 'execution reverted' },
  });
  return new ExecutionRevertedError({ cause: rpcErr, message: 'execution reverted' });
}

export interface FakePublicClientOptions {
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  callShouldRevert?: boolean;
  /**
   * Real viem TimeoutError, wrapped exactly the way an actual `eth_call` transport failure would be,
   * for testing RPC-vs-revert classification, not just a plain Error.
   */
  callShouldTimeout?: boolean;
  /** A real viem revert shape, simulating a doomed transaction caught during gas estimation. */
  estimateGasShouldRevert?: boolean;
  /** Real viem TimeoutError during estimateGas, wrapped in EstimateGasExecutionError. */
  estimateGasShouldTimeout?: boolean;
  broadcastHash?: `0x${string}`;
  /** Called at the start of `call()`: lets a test simulate an emergency stop being pressed mid-flow. */
  onCall?: () => void;
  /** Called with the raw serialized transaction right before "broadcasting" it. */
  captureBroadcast?: (serializedTransaction: `0x${string}`) => void;
  /** What `getTransaction` says about a hash: the node has it, does not (default), or cannot be reached. */
  transactionLookup?: 'known' | 'absent' | 'unreachable';
  receiptStatus?: 'success' | 'reverted';
  /** Logs to include on the receipt `waitForTransactionReceipt` resolves with. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  receiptLogs?: any[];
}

const FAKE_TARGET = { to: '0x0000000000000000000000000000000000dead' } as const;

export function fakePublicClient(opts: FakePublicClientOptions = {}) {
  const calls = { estimateGas: 0, estimateFeesPerGas: 0, call: 0, sendRawTransaction: 0 };

  const client = {
    calls,
    async estimateGas() {
      calls.estimateGas++;
      if (opts.estimateGasShouldTimeout) {
        throw new EstimateGasExecutionError(new TimeoutError({ body: {}, url: 'http://rpc.example' }), FAKE_TARGET);
      }
      if (opts.estimateGasShouldRevert) {
        throw new EstimateGasExecutionError(realRevertChain(), FAKE_TARGET);
      }
      return opts.gas ?? 21_000n;
    },
    async estimateFeesPerGas() {
      calls.estimateFeesPerGas++;
      return {
        maxFeePerGas: opts.maxFeePerGas ?? 30_000_000_000n,
        maxPriorityFeePerGas: opts.maxPriorityFeePerGas ?? 1_000_000_000n,
      };
    },
    async call() {
      calls.call++;
      opts.onCall?.();
      if (opts.callShouldTimeout) {
        throw new CallExecutionError(new TimeoutError({ body: {}, url: 'http://rpc.example' }), FAKE_TARGET);
      }
      if (opts.callShouldRevert) {
        throw new CallExecutionError(realRevertChain(), FAKE_TARGET);
      }
      return { data: '0x' as `0x${string}` };
    },
    async sendRawTransaction(args: { serializedTransaction: `0x${string}` }) {
      calls.sendRawTransaction++;
      opts.captureBroadcast?.(args.serializedTransaction);
      return opts.broadcastHash ?? (('0x' + 'ab'.repeat(32)) as `0x${string}`);
    },
    async getTransaction(args: { hash: `0x${string}` }) {
      if (opts.transactionLookup === 'known') return { hash: args.hash };
      if (opts.transactionLookup === 'unreachable') throw new TimeoutError({ body: {}, url: 'http://rpc.example' });
      throw new TransactionNotFoundError({ hash: args.hash });
    },
    async waitForTransactionReceipt() {
      return { status: opts.receiptStatus ?? 'success', transactionIndex: 0, logs: opts.receiptLogs ?? [] };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return client;
}
