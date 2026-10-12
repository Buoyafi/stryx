import type { TransactionScope } from './transaction.types.js';

export class TransactionEngineError extends Error {
  public readonly scope: TransactionScope;

  constructor(message: string, scope: TransactionScope) {
    super(message);
    this.name = new.target.name;
    this.scope = scope;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown at any of the checkpoints defined in ADR-001 §3.5. */
export class EmergencyStopActiveError extends TransactionEngineError {
  public readonly stage: string;

  constructor(scope: TransactionScope, stage: string) {
    super(`Emergency stop active for wallet=${scope.walletId} at stage=${stage}. Transaction aborted.`, scope);
    this.stage = stage;
  }
}

/**
 * ADR-002 §3.7: thrown at the pre-sign checkpoint when this transaction's value, added to what its
 * owner has already sent today, would exceed their configured daily cap.
 */
export class SpendingCapExceededError extends TransactionEngineError {
  constructor(
    scope: TransactionScope,
    public readonly capWei: bigint,
    public readonly attemptedTotalWei: bigint,
    /** Which budget ran out: the account's, or this one wallet's share of it. */
    public readonly budget: 'account' | 'wallet' = 'account',
  ) {
    super(
      budget === 'wallet'
        ? `Daily spending cap for this wallet (${scope.walletAddress}) exceeded on chain ${scope.chainId}: cap=${capWei} wei, ` +
            `this transaction would bring its total today to ${attemptedTotalWei} wei. Each wallet may spend only part of the ` +
            `account's daily cap, so use another wallet or wait for tomorrow (UTC). Transaction aborted.`
        : capWei === 0n
        ? `No daily spending cap is set for chain ${scope.chainId} on this account, so nothing can be sent there. ` +
            `Set one for this chain (DEFAULT_DAILY_SPEND_CAPS, in the chain's own token). Transaction aborted.`
        : `Daily spending cap exceeded for user=${scope.ownerId} on chain ${scope.chainId}: cap=${capWei} wei, ` +
            `this transaction would bring today's total to ${attemptedTotalWei} wei. Transaction aborted.`,
      scope,
    );
  }
}

/**
 * Thrown when a chain read the pre-sign pipeline depends on fails because the RPC could not be
 * reached. A network failure, not the contract rejecting the transaction: safe to retry.
 */
export class RpcUnavailableError extends TransactionEngineError {
  public readonly stage: string;

  constructor(scope: TransactionScope, stage: string, cause: unknown) {
    super(
      `Could not reach the chain for wallet=${scope.walletId} at stage=${stage}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. This is a network/RPC failure, ` +
        'not the contract rejecting the transaction: safe to retry.',
      scope,
    );
    this.stage = stage;
    this.cause = cause;
  }
}

/** Thrown when a pre-broadcast simulation (eth_call) reverts: the whole point of simulating first. */
export class SimulationRevertedError extends TransactionEngineError {
  constructor(scope: TransactionScope, cause: unknown) {
    super(
      `Transaction simulation reverted for wallet=${scope.walletId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      scope,
    );
    this.cause = cause;
  }

  /**
   * The raw revert bytes, if the node returned any. The eth_call has no ABI, so a caller that knows
   * the protocol decodes them.
   */
  get revertData(): `0x${string}` | undefined {
    const cause = this.cause;
    if (!cause || typeof cause !== 'object') return undefined;
    if (!('walk' in cause) || typeof (cause as { walk: unknown }).walk !== 'function') return undefined;

    const withData = (cause as { walk: (fn: (e: unknown) => boolean) => unknown }).walk(
      (e) => typeof e === 'object' && e !== null && 'data' in e && typeof (e as { data: unknown }).data === 'string',
    ) as { data?: `0x${string}` } | undefined;

    return withData?.data;
  }
}

/** The send call failed and the chain could not say whether the transaction got through. */
export class BroadcastUncertainError extends TransactionEngineError {
  constructor(
    scope: TransactionScope,
    public readonly hash: `0x${string}`,
    public readonly nonce: number,
    cause: unknown,
  ) {
    super(`Send outcome unknown for wallet=${scope.walletId}: it may have been broadcast. Check ${hash} before retrying.`, scope);
    this.cause = cause;
  }
}
