import { z } from 'zod';

/** Which wallet, on which chain, is executing this transaction, and for which owner. */
export const TransactionScopeSchema = z.object({
  chainId: z.number().int().positive(),
  walletId: z.string().min(1),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'walletAddress must be a 0x-prefixed 20-byte address'),
  ownerId: z.string().min(1),
  spendCapWei: z.bigint().nullable(),
  /** This wallet's own daily cap on this chain, inside the account's, so no single wallet can use up the account's day. */
  walletSpendCapWei: z.bigint().nullable().optional(),
});
export type TransactionScope = z.infer<typeof TransactionScopeSchema>;

/** A protocol-agnostic unsigned transaction request. */
export interface UnsignedTransactionRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

export type TransactionStatus = 'broadcast' | 'confirmed' | 'reverted';

export interface TransactionResult {
  hash: `0x${string}`;
  nonce: number;
  status: TransactionStatus;
}

export interface GasParameters {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Per-send options for `TransactionEngine.executeTransaction`. */
export interface ExecuteOptions {
  /** The priority fee (tip) to pay, in wei, instead of the node's suggestion. */
  priorityFeeWei?: bigint;
  /** Called once the transaction is signed and before it is sent, with the hash it will have on chain. */
  onSigned?: (signed: { hash: `0x${string}`; nonce: number }) => Promise<void> | void;
}

/** A step `TransactionEngine.executePrepared` reports as it passes it. */
export type PreparedExecutionStep = 'simulated' | 'signed' | 'broadcast';

export interface PreparedExecutionOptions {
  /** Used as-is: `executePrepared` never estimates gas. */
  gas: GasParameters;
  /** Run the eth_call simulation before signing. */
  simulate: boolean;
  /** Stop after simulation: no nonce, no spending-cap reservation, no signature, no broadcast. */
  dryRun: boolean;
  /** `simulateMs` is set on the 'simulated' step: how long the eth_call took. */
  onStep?: (step: PreparedExecutionStep, meta?: { simulateMs?: number }) => void;
}

export type PreparedExecutionResult =
  | { kind: 'broadcast'; hash: `0x${string}`; nonce: number }
  | { kind: 'dry-run'; simulated: boolean };
