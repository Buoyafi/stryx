import type { UserId, WalletDeletionCheck, WalletDeletionChecker } from '@stryx/wallet-service';
import { ERC721_ABI, ERC1155_ABI } from '@stryx/nft-engine';
import { isRpcTransportFailure, withTimeout } from '@stryx/utils';
import type { PublicClient } from 'viem';
import type { NftHoldingsProvider } from './nft-holdings.service.js';
import type { MintedNftRecord } from './nft-ledger-repository.js';

/**
 * When a wallet may be deleted: never while a scheduled mint uses it, and with funds or NFTs in it
 * only when its key also exists elsewhere (imported or exported).
 */
export interface WalletDeletionDeps {
  getBalances(address: `0x${string}`): Promise<{ chainName: string; wei: string; formatted: string; error?: string }[]>;
  /** Whether the wallet holds NFTs, per chain. A wallet with NFTs and no gas money is not empty. */
  getNftHoldings?(wallet: { id: string; address: `0x${string}` }): Promise<{ chainName: string; held: boolean; error?: string }[]>;
  /** How many pending scheduled mints (plain and signed) use this wallet. */
  scheduledUses?(ownerId: UserId, walletId: string): Promise<number>;
  /** Whether its owner ever exported this wallet's key (audit log). */
  keyExported?(walletId: string): Promise<boolean>;
}

export function makeWalletDeletionChecker(deps: WalletDeletionDeps): WalletDeletionChecker {
  return async (wallet, { keySaved }) => {
    const [balances, nfts, scheduled, exported] = await Promise.all([
      deps.getBalances(wallet.address as `0x${string}`),
      deps.getNftHoldings?.({ id: wallet.id, address: wallet.address as `0x${string}` }) ?? Promise.resolve([]),
      deps.scheduledUses?.(wallet.ownerId, wallet.id) ?? Promise.resolve(0),
      wallet.origin === 'IMPORTED' ? Promise.resolve(false) : (deps.keyExported?.(wallet.id) ?? Promise.resolve(false)),
    ]);
    const funds = [
      ...balances.filter((b) => !b.error && BigInt(b.wei) > 0n).map((b) => ({ chainName: b.chainName, amount: b.formatted })),
      ...nfts.filter((n) => n.held).map((n) => ({ chainName: n.chainName, amount: 'NFTs' })),
    ];
    // No chain to ask is not the same as an empty wallet.
    const unreadable = balances.length === 0 ? ['any chain'] : [...new Set([...balances, ...nfts].filter((r) => r.error).map((r) => r.chainName))];
    const keyElsewhere = wallet.origin === 'IMPORTED' ? 'imported' : exported ? 'exported' : null;
    const base = { funds, keyElsewhere, scheduled } as const;
    const holds = funds.map((f) => `${f.amount} on ${f.chainName}`).join(', ');

    const result = (canDelete: boolean, reason: WalletDeletionCheck['reason'], message: string): WalletDeletionCheck => ({ canDelete, reason, message, ...base });

    if (scheduled > 0) {
      return result(false, 'scheduled', `${scheduled === 1 ? 'A scheduled mint uses' : `${scheduled} scheduled mints use`} this wallet. Cancel ${scheduled === 1 ? 'it' : 'them'} in Activity first.`);
    }
    if (funds.length === 0 && unreadable.length === 0) return result(true, 'empty', 'Nothing on any chain. Deleting removes the wallet and its key from Stryx for good.');
    if (keyElsewhere) {
      const how = keyElsewhere === 'imported' ? 'You imported this wallet' : 'You exported this wallet’s key';
      const what = funds.length > 0 ? `It still holds ${holds}. ` : `${unreadable.join(', ')} could not be read, so it may hold funds. `;
      return keySaved
        ? result(true, 'key_elsewhere', `${what}Stryx forgets the wallet; the funds stay on chain, reachable with your saved key.`)
        : result(false, 'confirm_key', `${what}${how}, so the funds stay reachable with its private key. Confirm you have that key saved before deleting.`);
    }
    if (funds.length > 0) {
      return result(false, 'has_funds', `This wallet still holds ${holds}, and Stryx has the only copy of its key. Move the funds out first, or export its key, then delete it.`);
    }
    return result(false, 'balance_unreadable', `Could not read the balance on ${unreadable.join(', ')}, so funds cannot be ruled out. Try again in a moment.`);
  };
}

export interface NftCheckChain {
  chainId: number;
  chainName: string;
  publicClient: Pick<PublicClient, 'readContract'>;
  /** A live indexer for this chain, when one is configured: it sees every NFT, not only ours. */
  indexer?: NftHoldingsProvider;
}

const NFT_CHECK_TIMEOUT_MS = 8_000;
const MAX_LEDGER_TOKENS_CHECKED = 50;

/** "Does this wallet hold any NFT", per chain, for the deletion check. */
export function makeNftHoldingsCheck(deps: {
  chains: readonly NftCheckChain[];
  ledger: { listHeld(walletId: string, chainId: number): Promise<MintedNftRecord[]>; listReceived(address: string, chainId: number): Promise<MintedNftRecord[]> };
  timeoutMs?: number;
}): NonNullable<WalletDeletionDeps['getNftHoldings']> {
  const holdsOn = async (chain: NftCheckChain, wallet: { id: string; address: `0x${string}` }): Promise<boolean> => {
    if (chain.indexer) {
      try {
        return (await chain.indexer.listHoldings(wallet.address)).length > 0;
      } catch {
        // The ledger below still knows what Stryx itself put there.
      }
    }
    const [minted, received] = await Promise.all([deps.ledger.listHeld(wallet.id, chain.chainId), deps.ledger.listReceived(wallet.address, chain.chainId)]);
    for (const token of [...minted, ...received].slice(0, MAX_LEDGER_TOKENS_CHECKED)) {
      if (await ownsToken(chain.publicClient, token, wallet.address)) return true;
    }
    return false;
  };

  return (wallet) =>
    Promise.all(
      deps.chains.map(async (chain) => {
        try {
          return { chainName: chain.chainName, held: await withTimeout(holdsOn(chain, wallet), deps.timeoutMs ?? NFT_CHECK_TIMEOUT_MS, `${chain.chainName} NFT check`) };
        } catch {
          return { chainName: chain.chainName, held: false, error: 'NFTs could not be read.' };
        }
      }),
    );
}

/** A revert means the token is gone (burned, or never existed): not held. An unreachable chain throws. */
async function ownsToken(client: Pick<PublicClient, 'readContract'>, token: Pick<MintedNftRecord, 'contract' | 'tokenId' | 'standard'>, address: `0x${string}`): Promise<boolean> {
  try {
    if (token.standard === 'erc721') {
      const owner = await client.readContract({ address: token.contract as `0x${string}`, abi: ERC721_ABI, functionName: 'ownerOf', args: [BigInt(token.tokenId)] });
      return owner.toLowerCase() === address.toLowerCase();
    }
    return (await client.readContract({ address: token.contract as `0x${string}`, abi: ERC1155_ABI, functionName: 'balanceOf', args: [address, BigInt(token.tokenId)] })) > 0n;
  } catch (err) {
    if (isRpcTransportFailure(err)) throw err;
    return false;
  }
}

/** Scheduled-mint states that still count as "will use this wallet". */
export const PENDING_JOB_STATES = new Set(['delayed', 'waiting', 'waiting-children', 'prioritized', 'active', 'paused']);
