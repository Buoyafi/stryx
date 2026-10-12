import { withTimeout } from '@stryx/utils';
import { chainById } from './chain-registry.js';
import type { ChainServices } from './chain-services.js';

/** Same read budget as BalanceService: one unresponsive RPC must not hang the whole probe. */
const PROBE_TIMEOUT_MS = 8_000;

export interface ChainWithContract {
  chainId: number;
  name: string;
}

/**
 * For a bare contract address: which of the configured chains has code at it. A chain that cannot be
 * read this round does not get to claim the address.
 */
export async function probeChainsForContract(address: `0x${string}`, chainServices: ReadonlyMap<number, ChainServices>): Promise<ChainWithContract[]> {
  const entries = [...chainServices.entries()];

  const results = await Promise.all(
    entries.map(async ([chainId, services]): Promise<ChainWithContract | null> => {
      try {
        const code = await withTimeout(services.publicClient.getBytecode({ address }), PROBE_TIMEOUT_MS, `chain ${chainId} code probe`);
        if (!code || code === '0x') return null;
        return { chainId, name: chainById(chainId)?.name ?? `Chain ${chainId}` };
      } catch {
        // Unreadable this round: neither present nor absent.
        return null;
      }
    }),
  );

  return results.filter((r): r is ChainWithContract => r !== null).sort((a, b) => a.chainId - b.chainId);
}
