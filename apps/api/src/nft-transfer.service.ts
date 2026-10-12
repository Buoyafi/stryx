import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from 'viem';
import { NftTransferBuilder, ERC721_ABI, ERC1155_ABI } from '@stryx/nft-engine';
import type { WalletService, UserId } from '@stryx/wallet-service';
import { BroadcastUncertainError, EmergencyStopActiveError, SimulationRevertedError, RpcUnavailableError } from '@stryx/transaction-engine';
import type { ChainServices } from './chain-services.js';
import type { NftLedgerService } from './nft-ledger.service.js';
import { chainErrorText } from './chain-error-text.js';
import type { NftStandard } from './nft-ledger-repository.js';

export interface NftTransferItem {
  /** Source wallet currently holding this token. */
  walletId: string;
  contract: `0x${string}`;
  /** Decimal string: a tokenId routinely exceeds JS's safe-integer range. */
  tokenId: string;
  standard: NftStandard;
  /** "1" for a 721; the quantity to move for a 1155. */
  amount: string;
}

export interface NftTransferResult {
  walletId: string;
  contract: string;
  tokenId: string;
  standard: NftStandard;
  /** 'unknown': the send call failed and the chain could not say whether it went out. */
  status: 'sent' | 'skipped' | 'failed' | 'unknown';
  hash?: string;
  nonce?: number;
  error?: string;
}

export interface NftTransferOutcome {
  ok: boolean;
  /** Set when the whole operation was rejected before ANY transfer was attempted. */
  preflightError?: 'unsupported_chain' | 'no_items' | 'destination_is_source';
  /** Set when the batch was halted partway through by a stop or an unreachable chain. */
  haltReason?: 'emergency_stop' | 'rpc_unavailable';
  detail?: string;
  results: NftTransferResult[];
}

/** Each wait is about three minutes: a transfer is watched for about half an hour. */
const CONFIRM_ATTEMPTS = 10;

/**
 * Moves NFTs out of one or more custodial wallets to a single destination. Transfers go one at a time,
 * a failure does not stop the rest, and a stop, a cap or an unreachable chain halts the batch.
 */
export class NftTransferService {
  /** Sends still waiting to be mined, so their ledger rows can be marked once they are. */
  private readonly settling = new Set<Promise<void>>();

  constructor(
    private readonly walletService: WalletService,
    private readonly chainServices: Map<number, ChainServices>,
    private readonly ledger: NftLedgerService,
    private readonly builder: NftTransferBuilder = new NftTransferBuilder(),
  ) {}

  /** Resolves once every send this service is still watching has settled. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.settling.size > 0) await Promise.all([...this.settling]);
  }

  /** The ledger says "moved" only once the chain does. */
  private watch(chain: ChainServices, sent: { hash: `0x${string}`; nonce: number }, item: NftTransferItem, chainId: number, destination: `0x${string}`, onReverted?: (item: NftTransferItem, hash: string) => Promise<void>): void {
    const task = (async () => {
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
        try {
          const settled = await chain.transactionEngine.waitForConfirmation(sent.hash, sent.nonce);
          if (settled.status === 'confirmed') {
            await this.ledger.markTransferred({ chainId, contract: item.contract, tokenId: item.tokenId, walletId: item.walletId }, destination);
          } else {
            await onReverted?.(item, sent.hash);
          }
          return;
        } catch {
          // Not mined yet, or the chain did not answer: look again.
        }
      }
    })().catch(() => undefined);
    this.settling.add(task);
    void task.finally(() => this.settling.delete(task));
  }

  async transfer(params: {
    ownerId: UserId;
    chainId: number;
    destination: `0x${string}`;
    items: readonly NftTransferItem[];
    /** Called if a send that went out is later reverted by the chain: the token did not move. */
    onReverted?: (item: NftTransferItem, hash: string) => Promise<void>;
  }): Promise<NftTransferOutcome> {
    const { ownerId, chainId, destination, items } = params;

    if (items.length === 0) {
      return { ok: false, preflightError: 'no_items', results: [] };
    }

    const chain = this.chainServices.get(chainId);
    if (!chain) {
      return { ok: false, preflightError: 'unsupported_chain', detail: `chainId=${chainId} has no RPC configured.`, results: [] };
    }

    const walletIds = [...new Set(items.map((i) => i.walletId))];
    const wallets = new Map(
      await Promise.all(walletIds.map(async (id) => [id, await this.walletService.getWalletSummary(ownerId, id)] as const)),
    );

    if ([...wallets.values()].some((w) => w.address.toLowerCase() === destination.toLowerCase())) {
      return {
        ok: false,
        preflightError: 'destination_is_source',
        detail: 'Destination cannot be one of the source wallets.',
        results: [],
      };
    }

    const results: NftTransferResult[] = [];
    let haltReason: NftTransferOutcome['haltReason'];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const walletAddress = wallets.get(item.walletId)!.address as `0x${string}`;
      const base = { walletId: item.walletId, contract: item.contract, tokenId: item.tokenId, standard: item.standard };

      try {
        const held = await this.verifyOwnership(chain, item, walletAddress);
        if ('unreadable' in held) {
          // Not the same as "no longer held": the chain did not answer, so nothing is known.
          results.push({ ...base, status: 'failed', error: `Could not check who holds it, so it was not sent: ${held.unreadable}` });
          continue;
        }
        if (!held.held) {
          results.push({ ...base, status: 'skipped', error: 'No longer held by this wallet.' });
          // The chain names who has it now: a ledger row still saying "held" is put right.
          if (held.owner) {
            await this.ledger.markTransferred({ chainId, contract: item.contract, tokenId: item.tokenId, walletId: item.walletId }, held.owner).catch(() => undefined);
          }
          continue;
        }

        const unsignedTx =
          item.standard === 'erc721'
            ? this.builder.buildErc721Transfer(item.contract, walletAddress, destination, BigInt(item.tokenId))
            : this.builder.buildErc1155Transfer(item.contract, walletAddress, destination, BigInt(item.tokenId), BigInt(item.amount));

        const tx = await chain.transactionEngine.executeTransaction(
          { chainId, walletId: item.walletId, walletAddress, ownerId, spendCapWei: null },
          unsignedTx,
        );
        results.push({ ...base, status: 'sent', hash: tx.hash, nonce: tx.nonce });
        this.watch(chain, tx, item, chainId, destination, params.onReverted);
      } catch (err) {
        if (err instanceof BroadcastUncertainError) {
          results.push({ ...base, status: 'unknown', hash: err.hash, nonce: err.nonce, error: 'May have been sent. Check it before sending again.' });
          continue;
        }
        const message =
          err instanceof EmergencyStopActiveError
            ? `Emergency stop active (stage: ${err.stage})`
            : err instanceof RpcUnavailableError
              ? `Chain unreachable: ${err.message}`
              : err instanceof SimulationRevertedError
                ? `Simulation reverted: ${err.message}`
                : chainErrorText(err);

        results.push({ ...base, status: 'failed', error: message });

        if (err instanceof EmergencyStopActiveError || err instanceof RpcUnavailableError) {
          haltReason = err instanceof RpcUnavailableError ? 'rpc_unavailable' : 'emergency_stop';
          const skipReason = err instanceof RpcUnavailableError ? 'Skipped: chain was unreachable' : 'Skipped: emergency stop halted the batch';
          for (let j = i + 1; j < items.length; j++) {
            const skipped = items[j]!;
            results.push({
              walletId: skipped.walletId,
              contract: skipped.contract,
              tokenId: skipped.tokenId,
              standard: skipped.standard,
              status: 'failed',
              error: skipReason,
            });
          }
          break;
        }
      }
    }

    return { ok: results.every((r) => r.status === 'sent'), ...(haltReason ? { haltReason } : {}), results };
  }

  /** Not held only when the chain itself says so (another owner, too small a balance, or the call reverted). */
  private async verifyOwnership(
    chain: ChainServices,
    item: NftTransferItem,
    walletAddress: `0x${string}`,
  ): Promise<{ held: true } | { held: false; owner?: string } | { unreadable: string }> {
    try {
      if (item.standard === 'erc721') {
        const owner = await chain.publicClient.readContract({
          address: item.contract,
          abi: ERC721_ABI,
          functionName: 'ownerOf',
          args: [BigInt(item.tokenId)],
        });
        return owner.toLowerCase() === walletAddress.toLowerCase() ? { held: true } : { held: false, owner };
      }
      const balance = await chain.publicClient.readContract({
        address: item.contract,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [walletAddress, BigInt(item.tokenId)],
      });
      return { held: balance >= BigInt(item.amount) };
    } catch (err) {
      // A revert is the contract's answer (burned or nonexistent token): not held.
      return isContractRevert(err) ? { held: false } : { unreadable: chainErrorText(err) };
    }
  }
}

function isContractRevert(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null) return true;
  return /execution reverted/i.test(err instanceof Error ? err.message : String(err));
}
