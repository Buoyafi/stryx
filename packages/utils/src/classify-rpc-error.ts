import {
  BaseError,
  TimeoutError,
  HttpRequestError,
  RpcRequestError,
  SocketClosedError,
  ExecutionRevertedError,
  ContractFunctionRevertedError,
  InvalidInputRpcError,
  TransactionRejectedRpcError,
  InsufficientFundsError,
} from 'viem';
import { TimeoutBudgetExceededError } from './with-timeout.js';

/**
 * Tells an RPC or network failure (timeout, refused connection, rate limit) from a genuine on-chain
 * rejection. Both arrive wrapped in the same outer viem error, so only the cause chain says which.
 */
export function isRpcTransportFailure(err: unknown): boolean {
  if (err instanceof TimeoutBudgetExceededError) return true;
  if (!(err instanceof BaseError)) return false;

  // A revert is checked first: its cause chain also holds an RpcRequestError, which would otherwise
  // read as a transport failure.
  const isRevert =
    err.walk(
      (e) =>
        e instanceof ExecutionRevertedError ||
        e instanceof ContractFunctionRevertedError ||
        (e instanceof RpcRequestError && e.code === ExecutionRevertedError.code),
    ) !== null;
  if (isRevert) return false;

  // viem's other node rejections (insufficient funds, nonce too low) are built on one of these two,
  // and are not transport failures either.
  const isDeterministicNodeRejection =
    err.walk((e) => e instanceof InvalidInputRpcError || e instanceof TransactionRejectedRpcError) !== null;
  if (isDeterministicNodeRejection) return false;

  return (
    err.walk(
      (e) =>
        e instanceof TimeoutError ||
        e instanceof HttpRequestError ||
        e instanceof RpcRequestError ||
        e instanceof SocketClosedError,
    ) !== null
  );
}

const OUT_OF_FUNDS_TEXT = /insufficient funds|out ?of ?funds|insufficient balance for transfer/i;

/** True when the node refused a call because the sender cannot pay for it. */
export function isInsufficientFundsFailure(err: unknown): boolean {
  const root = err instanceof BaseError ? err : err instanceof Error ? err.cause : undefined;
  if (!(root instanceof BaseError)) return false;
  if (root.walk((e) => e instanceof InsufficientFundsError) !== null) return true;
  const isRevert = (e: unknown) =>
    e instanceof ExecutionRevertedError || e instanceof ContractFunctionRevertedError || (e instanceof RpcRequestError && e.code === ExecutionRevertedError.code);
  if (root.walk(isRevert) !== null) return false;
  return root.walk((e) => e instanceof RpcRequestError && OUT_OF_FUNDS_TEXT.test(e.details)) !== null;
}
