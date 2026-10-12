import { describe, expect, it } from 'vitest';
import {
  CallExecutionError,
  EstimateGasExecutionError,
  ContractFunctionExecutionError,
  ExecutionRevertedError,
  ContractFunctionRevertedError,
  TimeoutError,
  HttpRequestError,
  RpcRequestError,
  SocketClosedError,
  InvalidInputRpcError,
  TransactionRejectedRpcError,
  InsufficientFundsError,
  NonceTooLowError,
} from 'viem';
import { isRpcTransportFailure, isInsufficientFundsFailure } from '../src/classify-rpc-error.js';
import { TimeoutBudgetExceededError } from '../src/with-timeout.js';

const TARGET = { to: '0x0000000000000000000000000000000000dead' } as const;

/**
 * Builds the error chain viem really constructs for an `eth_call` or `estimateGas` revert: the raw
 * JSON-RPC error is the revert error's cause. A shape without that nesting would not prove the
 * classifier works.
 */
function realRevertChain(): ExecutionRevertedError {
  const rpcErr = new RpcRequestError({
    body: {},
    url: 'http://rpc.example',
    error: { code: 3, message: 'execution reverted' },
  });
  return new ExecutionRevertedError({ cause: rpcErr, message: 'execution reverted' });
}

/** Same, but for the `readContract` (with ABI) path SeaDropReader uses. */
function realContractRevertChain(): ContractFunctionRevertedError {
  const rpcErr = new RpcRequestError({
    body: {},
    url: 'http://rpc.example',
    error: { code: 3, message: 'execution reverted' },
  });
  return new ContractFunctionRevertedError({ abi: [], functionName: 'getPublicDrop', message: 'execution reverted', cause: rpcErr });
}

/**
 * The chain viem builds for "insufficient funds for gas": RpcRequestError (code -32000) ->
 * InvalidInputRpcError -> InsufficientFundsError.
 */
function realInsufficientFundsChain(): InsufficientFundsError {
  const rpcErr = new RpcRequestError({
    body: {},
    url: 'http://rpc.example',
    error: { code: -32000, message: 'err: insufficient funds for gas * price + value: address 0x0 have 0 want 2000000000000000' },
  });
  const invalidInput = new InvalidInputRpcError(rpcErr);
  return new InsufficientFundsError({ cause: invalidInput });
}

/**
 * Same shape, a different node-classified rejection (nonce too low), to prove the fix isn't hardcoded
 * to insufficient-funds specifically.
 */
function realNonceTooLowChain(): NonceTooLowError {
  const rpcErr = new RpcRequestError({
    body: {},
    url: 'http://rpc.example',
    error: { code: -32000, message: 'nonce too low' },
  });
  const invalidInput = new InvalidInputRpcError(rpcErr);
  return new NonceTooLowError({ cause: invalidInput, nonce: 5 });
}

describe('isRpcTransportFailure', () => {
  describe('reverts (must never be misclassified as a transport failure: see file header)', () => {
    it('returns false for a REAL eth_call revert chain (RpcRequestError -> ExecutionRevertedError -> CallExecutionError)', () => {
      const callError = new CallExecutionError(realRevertChain(), TARGET);
      expect(isRpcTransportFailure(callError)).toBe(false);
    });

    it('returns false for a REAL estimateGas revert chain (RpcRequestError -> ExecutionRevertedError -> EstimateGasExecutionError)', () => {
      const estimateError = new EstimateGasExecutionError(realRevertChain(), TARGET);
      expect(isRpcTransportFailure(estimateError)).toBe(false);
    });

    it('returns false for a REAL readContract revert chain (RpcRequestError -> ContractFunctionRevertedError -> ContractFunctionExecutionError): the shape SeaDropReader hits', () => {
      const contractError = new ContractFunctionExecutionError(realContractRevertChain(), {
        abi: [],
        functionName: 'getPublicDrop',
      });
      expect(isRpcTransportFailure(contractError)).toBe(false);
    });

    it('returns false for a bare, unwrapped RpcRequestError carrying the revert code directly (defensive path, not just the wrapped case)', () => {
      const rpcErr = new RpcRequestError({
        body: {},
        url: 'http://rpc.example',
        error: { code: 3, message: 'execution reverted' },
      });
      expect(isRpcTransportFailure(rpcErr)).toBe(false);
    });

    it('returns false for a raw ExecutionRevertedError with no wrapping', () => {
      expect(isRpcTransportFailure(realRevertChain())).toBe(false);
    });
  });

  describe('other deterministic node rejections (these were being misclassified as "network failure, safe to retry")', () => {
    it('returns false for a REAL insufficient-funds-for-gas chain (RpcRequestError -> InvalidInputRpcError -> InsufficientFundsError -> CallExecutionError), the exact shape TransactionSimulator hits', () => {
      const callError = new CallExecutionError(realInsufficientFundsChain(), TARGET);
      expect(isRpcTransportFailure(callError)).toBe(false);
    });

    it('returns false for the same shape through EstimateGasExecutionError (the GasEstimator path)', () => {
      const estimateError = new EstimateGasExecutionError(realInsufficientFundsChain(), TARGET);
      expect(isRpcTransportFailure(estimateError)).toBe(false);
    });

    it('returns false for a raw InsufficientFundsError with no outer wrapping', () => {
      expect(isRpcTransportFailure(realInsufficientFundsChain())).toBe(false);
    });

    it('returns false for a different node-classified rejection (nonce too low): the fix is not hardcoded to insufficient-funds specifically', () => {
      const callError = new CallExecutionError(realNonceTooLowChain(), TARGET);
      expect(isRpcTransportFailure(callError)).toBe(false);
    });

    it('returns false for a bare InvalidInputRpcError itself (the signal this checks for directly)', () => {
      const rpcErr = new RpcRequestError({ body: {}, url: 'http://rpc.example', error: { code: -32000, message: 'invalid params' } });
      expect(isRpcTransportFailure(new InvalidInputRpcError(rpcErr))).toBe(false);
    });

    it('returns false for a bare TransactionRejectedRpcError itself', () => {
      const rpcErr = new RpcRequestError({ body: {}, url: 'http://rpc.example', error: { code: -32003, message: 'transaction creation failed' } });
      expect(isRpcTransportFailure(new TransactionRejectedRpcError(rpcErr))).toBe(false);
    });
  });

  describe('genuine transport failures', () => {
    it('returns true for a TimeoutError wrapped in CallExecutionError (eth_call shape)', () => {
      const timeout = new TimeoutError({ body: {}, url: 'http://rpc.example' });
      const callError = new CallExecutionError(timeout, TARGET);

      expect(isRpcTransportFailure(callError)).toBe(true);
    });

    it('returns true for a TimeoutError wrapped in EstimateGasExecutionError (estimateGas shape)', () => {
      const timeout = new TimeoutError({ body: {}, url: 'http://rpc.example' });
      const estimateError = new EstimateGasExecutionError(timeout, TARGET);

      expect(isRpcTransportFailure(estimateError)).toBe(true);
    });

    it('returns true for a raw TimeoutError with no wrapping', () => {
      expect(isRpcTransportFailure(new TimeoutError({ body: {}, url: 'http://rpc.example' }))).toBe(true);
    });

    it('returns true for an HttpRequestError (non-2xx / malformed response)', () => {
      expect(isRpcTransportFailure(new HttpRequestError({ url: 'http://rpc.example', body: {}, status: 503 }))).toBe(
        true,
      );
    });

    it('returns true for an RpcRequestError carrying a NON-revert JSON-RPC error code (e.g. rate limiting)', () => {
      const err = new RpcRequestError({
        body: {},
        url: 'http://rpc.example',
        error: { code: -32005, message: 'rate limit exceeded' },
      });
      expect(isRpcTransportFailure(err)).toBe(true);
    });

    it('returns true for a SocketClosedError (connection dropped mid-request)', () => {
      expect(isRpcTransportFailure(new SocketClosedError({}))).toBe(true);
    });

    it("returns true for withTimeout's own TimeoutBudgetExceededError, which is not a viem BaseError at all", () => {
      expect(isRpcTransportFailure(new TimeoutBudgetExceededError('some RPC call', 8000))).toBe(true);
    });
  });

  describe('neither', () => {
    it('returns false for a plain, non-viem Error', () => {
      expect(isRpcTransportFailure(new Error('something else entirely'))).toBe(false);
    });

    it('returns false for a non-Error rejection value', () => {
      expect(isRpcTransportFailure('a plain string rejection')).toBe(false);
      expect(isRpcTransportFailure(undefined)).toBe(false);
      expect(isRpcTransportFailure(null)).toBe(false);
    });
  });
});

/** What Alchemy's mainnet node answered a live check from an empty wallet with: viem has no class for this wording. */
function outOfFundsChain(): CallExecutionError {
  const rpcErr = new RpcRequestError({ body: {}, url: 'http://rpc.example', error: { code: -32003, message: 'EVM error: OutOfFunds' } });
  return new CallExecutionError(new TransactionRejectedRpcError(rpcErr), TARGET);
}

describe('isInsufficientFundsFailure', () => {
  it("is true for viem's own InsufficientFundsError chain", () => {
    expect(isInsufficientFundsFailure(new CallExecutionError(realInsufficientFundsChain(), TARGET))).toBe(true);
  });

  it('is true for a node that words it "OutOfFunds"', () => {
    expect(isInsufficientFundsFailure(outOfFundsChain())).toBe(true);
  });

  it('is true when an engine error wraps the chain error as its cause', () => {
    expect(isInsufficientFundsFailure(new Error('Transaction simulation reverted', { cause: outOfFundsChain() }))).toBe(true);
  });

  it('is false for a contract revert, even one whose text mentions funds', () => {
    const rpcErr = new RpcRequestError({ body: {}, url: 'http://rpc.example', error: { code: 3, message: 'execution reverted: insufficient funds' } });
    const revert = new ExecutionRevertedError({ cause: rpcErr, message: 'insufficient funds' });
    expect(isInsufficientFundsFailure(new CallExecutionError(revert, TARGET))).toBe(false);
    expect(isInsufficientFundsFailure(new CallExecutionError(realRevertChain(), TARGET))).toBe(false);
  });

  it('is false for other node rejections, transport failures and non-viem errors', () => {
    expect(isInsufficientFundsFailure(new CallExecutionError(realNonceTooLowChain(), TARGET))).toBe(false);
    expect(isInsufficientFundsFailure(new CallExecutionError(new TimeoutError({ body: {}, url: 'http://rpc.example' }), TARGET))).toBe(false);
    expect(isInsufficientFundsFailure(new Error('something else entirely'))).toBe(false);
    expect(isInsufficientFundsFailure(undefined)).toBe(false);
  });
});
