import type { ChainNonceReader, NonceScope } from './types.js';

/** The minimal subset of viem's PublicClient this package needs. */
export interface MinimalPublicClient {
  getTransactionCount(args: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
}

/** Reads the pending nonce directly from an EVM node via the platform's multi-RPC layer. */
export class ViemChainNonceReader implements ChainNonceReader {
  constructor(private readonly client: MinimalPublicClient) {}

  async getPendingNonce(scope: NonceScope): Promise<number> {
    return this.client.getTransactionCount({
      address: scope.walletAddress as `0x${string}`,
      blockTag: 'pending',
    });
  }
}
