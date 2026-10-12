import { keccak256, TransactionNotFoundError, type PublicClient, type TransactionReceipt } from 'viem';
import type { NonceManager, NonceScope } from '@stryx/nonce-manager';
import { BroadcastUncertainError, EmergencyStopActiveError, SpendingCapExceededError } from '../types/errors.js';
import { TransactionScopeSchema } from '../types/transaction.types.js';
import type {
  TransactionScope,
  TransactionResult,
  UnsignedTransactionRequest,
  GasParameters,
  PreparedExecutionOptions,
  ExecuteOptions,
  PreparedExecutionResult,
  PreparedExecutionStep,
} from '../types/transaction.types.js';
import { EmergencyStopGuard } from './emergency-stop.service.js';
import { SpendingCapGuard } from './spending-cap.service.js';
import { GasEstimator } from './gas-estimator.service.js';
import { TransactionSimulator } from './transaction-simulator.service.js';
import { TransactionSigner } from './transaction-signer.service.js';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Takes a transaction from unsigned request to broadcast, following ADR-001 §3.5's checkpoints. The
 * emergency stop is checked before the build, before simulation, before signing (the last point it is
 * guaranteed) and once more before sending. A nonce is allocated only after simulation succeeds and
 * released on any failure before the send. A send that throws proves nothing, so the chain is asked
 * first (settleFailedSend).
 */
export class TransactionEngine {
  constructor(
    private readonly nonceManager: NonceManager,
    private readonly emergencyStopGuard: EmergencyStopGuard,
    private readonly spendingCapGuard: SpendingCapGuard,
    private readonly gasEstimator: GasEstimator,
    private readonly simulator: TransactionSimulator,
    private readonly signer: TransactionSigner,
    private readonly client: PublicClient,
    private readonly logger: Logger = noopLogger,
    /**
     * Sends a signed transaction, in place of `client.sendRawTransaction`: used to hand the same bytes
     * to several RPC endpoints at once and take the first to accept.
     */
    private readonly broadcast?: (serializedTransaction: `0x${string}`) => Promise<`0x${string}`>,
  ) {}

  async executeTransaction(
    rawScope: TransactionScope,
    unsignedTx: UnsignedTransactionRequest,
    options: ExecuteOptions = {},
  ): Promise<TransactionResult> {
    const scope = TransactionScopeSchema.parse(rawScope);

    await this.assertNotStopped(scope, 'strategy-evaluation');

    const gasParams = await this.gasEstimator.estimate(scope, unsignedTx, options);

    await this.assertNotStopped(scope, 'pre-simulation');
    await this.simulator.simulate(scope, unsignedTx);

    return this.signAndBroadcast(scope, unsignedTx, gasParams, undefined, options.onSigned);
  }

  /**
   * The same checkpoints as `executeTransaction`, for a caller that has already chosen its gas and
   * cannot afford a live estimate on its hot path (the signed-mint runner).
   */
  async executePrepared(
    rawScope: TransactionScope,
    unsignedTx: UnsignedTransactionRequest,
    options: PreparedExecutionOptions,
  ): Promise<PreparedExecutionResult> {
    const scope = TransactionScopeSchema.parse(rawScope);

    await this.assertNotStopped(scope, 'strategy-evaluation');

    if (options.simulate) {
      await this.assertNotStopped(scope, 'pre-simulation');
      const started = performance.now();
      await this.simulator.simulate(scope, unsignedTx);
      this.report(options.onStep, 'simulated', { simulateMs: Math.round(performance.now() - started) });
    }

    if (options.dryRun) {
      this.logger.info('dry run: stopped before signing', { ...scope, simulated: options.simulate });
      return { kind: 'dry-run', simulated: options.simulate };
    }

    const result = await this.signAndBroadcast(scope, unsignedTx, options.gas, options.onStep);
    return { kind: 'broadcast', hash: result.hash, nonce: result.nonce };
  }

  private async signAndBroadcast(
    scope: TransactionScope,
    unsignedTx: UnsignedTransactionRequest,
    gasParams: GasParameters,
    onStep?: PreparedExecutionOptions['onStep'],
    onSigned?: ExecuteOptions['onSigned'],
  ): Promise<TransactionResult> {
    const nonce = await this.nonceManager.getNextNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress });
    let capReserved: { day?: string } | null = null;
    let walletCapReserved: { day?: string } | null = null;
    const walletCapWei = scope.walletSpendCapWei ?? null;
    let attempted: `0x${string}` | undefined;

    try {
      await this.assertNotStopped(scope, 'pre-sign'); // hard stop guarantee: last point stop is guaranteed effective

      const reservation = await this.spendingCapGuard.reserve(spendBudgetId(scope), unsignedTx.value, scope.spendCapWei);
      if (!reservation.ok) {
        throw new SpendingCapExceededError(scope, reservation.capWei, reservation.attemptedTotal);
      }
      capReserved = { ...(reservation.day ? { day: reservation.day } : {}) };
      // Then this wallet's own share of the account's day (per-wallet caps).
      if (walletCapWei !== null) {
        const walletReservation = await this.spendingCapGuard.reserve(walletBudgetId(scope), unsignedTx.value, walletCapWei);
        if (!walletReservation.ok) {
          throw new SpendingCapExceededError(scope, walletReservation.capWei, walletReservation.attemptedTotal, 'wallet');
        }
        walletCapReserved = { ...(walletReservation.day ? { day: walletReservation.day } : {}) };
      }

      const signedTx = await this.signer.sign(scope.walletId, {
        to: unsignedTx.to,
        data: unsignedTx.data,
        value: unsignedTx.value,
        nonce,
        gas: gasParams.gas,
        maxFeePerGas: gasParams.maxFeePerGas,
        maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
        chainId: scope.chainId,
        type: 'eip1559',
      });
      const signedHash = keccak256(signedTx);
      this.report(onStep, 'signed');
      if (onSigned) {
        try {
          await onSigned({ hash: signedHash, nonce });
        } catch (hookErr) {
          // The caller's bookkeeping failing must not stop a signed mint: its record repairs later.
          this.logger.error('onSigned hook failed; sending anyway', { ...scope, nonce, err: hookErr instanceof Error ? hookErr.message : String(hookErr) });
        }
      }

      // Best effort: a stop pressed after the send has started cannot be caught here.
      if (await this.emergencyStopGuard.isStopped(scope.walletId, scope.ownerId)) {
        throw new EmergencyStopActiveError(scope, 'post-sign-pre-broadcast');
      }

      attempted = signedHash;
      const hash = this.broadcast ? await this.broadcast(signedTx) : await this.client.sendRawTransaction({ serializedTransaction: signedTx });
      this.report(onStep, 'broadcast');

      this.logger.info('transaction broadcast', { ...scope, nonce, hash });
      return { hash, nonce, status: 'broadcast' };
    } catch (err) {
      let nonceStillOurs = true;
      if (attempted) {
        const fate = await this.settleFailedSend(scope, nonce, attempted);
        if (fate === 'sent') {
          this.logger.warn('send call failed but the chain has the transaction; treating as broadcast', { ...scope, nonce, hash: attempted });
          this.report(onStep, 'broadcast');
          return { hash: attempted, nonce, status: 'broadcast' };
        }
        if (fate === 'unknown' || fate === 'unknown-nonce-free') {
          // The budgets stay charged, and the caller is told to check the hash before retrying.
          if (fate === 'unknown-nonce-free') await this.releaseNonceQuietly(scope, nonce);
          this.logger.error('send outcome unknown', { ...scope, nonce, hash: attempted, err: err instanceof Error ? err.message : String(err) });
          throw new BroadcastUncertainError(scope, attempted, nonce, err);
        }
        nonceStillOurs = fate === 'not-sent';
      }
      // Nothing went out: the nonce goes back to the pool (unless the chain used it) and the spending
      // reservation is released.
      if (nonceStillOurs) await this.releaseNonceQuietly(scope, nonce);
      if (capReserved) {
        await this.spendingCapGuard.release(spendBudgetId(scope), unsignedTx.value, scope.spendCapWei, capReserved.day).catch((releaseErr: unknown) => {
          this.logger.error('failed to release spending cap reservation after aborted transaction', {
            ...scope,
            releaseErr: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
          });
        });
      }
      if (walletCapReserved) {
        await this.spendingCapGuard.release(walletBudgetId(scope), unsignedTx.value, walletCapWei, walletCapReserved.day).catch((releaseErr: unknown) => {
          this.logger.error('failed to release wallet spending cap reservation after aborted transaction', {
            ...scope,
            releaseErr: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
          });
        });
      }
      throw err;
    }
  }

  /** Asks the chain what became of a transaction whose send call threw. */
  private async settleFailedSend(
    scope: TransactionScope,
    nonce: number,
    hash: `0x${string}`,
  ): Promise<'sent' | 'not-sent' | 'nonce-taken' | 'unknown' | 'unknown-nonce-free'> {
    let lookedUp = false;
    try {
      await this.client.getTransaction({ hash });
      return 'sent';
    } catch (lookupErr) {
      lookedUp = lookupErr instanceof TransactionNotFoundError;
    }
    try {
      const chainPending = await this.nonceManager.catchUpToChain({ chainId: scope.chainId, walletAddress: scope.walletAddress });
      if (chainPending <= nonce) return 'not-sent';
      return lookedUp ? 'nonce-taken' : 'unknown';
    } catch {
      return 'unknown-nonce-free';
    }
  }

  private async releaseNonceQuietly(scope: TransactionScope, nonce: number): Promise<void> {
    await this.nonceManager.releaseNonce({ chainId: scope.chainId, walletAddress: scope.walletAddress }, nonce).catch((releaseErr: unknown) => {
      this.logger.error('failed to release nonce after aborted transaction', {
        ...scope,
        nonce,
        releaseErr: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    });
  }

  /** Pays a wallet's one-time nonce cold-start read ahead of an actual send. */
  async warmNonce(scope: NonceScope): Promise<void> {
    if (await this.nonceManager.ensureInitialized(scope)) return;
    // Already counted: check the counter has not run ahead of the chain (sends the node dropped).
    await this.nonceManager.healIfAhead(scope).catch((err: unknown) => {
      this.logger.warn('nonce health check failed during warm-up', { ...scope, err: err instanceof Error ? err.message : String(err) });
    });
  }

  /**
   * Gets a wallet's signing path ready ahead of a time-critical send: fetches its encrypted record and
   * opens the KMS connection with a throwaway unwrap. The private key is not decrypted.
   */
  async warmSigning(walletId: string, opts: { holdKeyMs?: number } = {}): Promise<void> {
    await this.signer.prepare(walletId, opts);
  }

  /** Zeroes a data key held by `warmSigning(..., { holdKeyMs })`. Safe to call when nothing is held. */
  releaseSigning(walletId: string): void {
    this.signer.release(walletId);
  }

  /** `nonce` is passed in: a block's transactionIndex is not the transaction's nonce. */
  async waitForConfirmation(hash: `0x${string}`, nonce: number): Promise<TransactionResult & { receipt: TransactionReceipt }> {
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    return {
      hash,
      nonce,
      status: receipt.status === 'success' ? 'confirmed' : 'reverted',
      receipt,
    };
  }

  /** Calls a caller's step callback without letting it throw into the engine. */
  private report(onStep: PreparedExecutionOptions['onStep'], step: PreparedExecutionStep, meta?: { simulateMs?: number }): void {
    if (!onStep) return;
    try {
      onStep(step, meta);
    } catch (err) {
      this.logger.error('onStep callback threw; ignored', { step, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async assertNotStopped(scope: TransactionScope, stage: string): Promise<void> {
    if (await this.emergencyStopGuard.isStopped(scope.walletId, scope.ownerId)) {
      throw new EmergencyStopActiveError(scope, stage);
    }
  }
}

/** One spending budget per user PER CHAIN. */
export function spendBudgetId(scope: Pick<TransactionScope, 'ownerId' | 'chainId'>): string {
  return `${scope.ownerId}:${scope.chainId}`;
}

/** One wallet's own budget inside its owner's, per chain: spend:{userId}:{chainId}:wallet:{walletId}:{day}. */
export function walletBudgetId(scope: Pick<TransactionScope, 'ownerId' | 'chainId' | 'walletId'>): string {
  return `${spendBudgetId(scope)}:wallet:${scope.walletId}`;
}
