import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { UserId } from '@stryx/wallet-service';
import type { Logger } from '@stryx/logger';
import { parseMintedTokens } from '@stryx/nft-engine';
import type { ChainServices } from './chain-services.js';
import type { NftLedgerService } from './nft-ledger.service.js';
import type { NftStandard } from './nft-ledger-repository.js';
import type { NftTransferService } from './nft-transfer.service.js';
import type { VaultSettingsService } from './vault-settings.service.js';
import { chainErrorText } from './chain-error-text.js';

const QUEUE_NAME = 'mint-confirmations';

export interface MintConfirmationJob {
  hash: `0x${string}`;
  nonce: number;
  walletId: string;
  walletAddress: `0x${string}`;
  chainId: number;
  contract: `0x${string}`;
  ownerId: UserId;
  standard: NftStandard;
  /** Set once the ledger rows are written, so a retry goes straight to the vault step. */
  recorded?: { tokenId: string; amount: string }[];
}

/**
 * How long a mint is waited for: each try waits about 3 minutes for the receipt, and a mint still not
 * mined is tried again after 1, 2, 4... minutes, about a day and a half in all.
 */
const ATTEMPTS = 12;
const FIRST_RETRY_MS = 60_000;

/** Watches a just-sent mint through to confirmation, server-side, and records what it produced. */
export class MintConfirmationWatcher {
  private readonly queue: Queue<MintConfirmationJob>;
  private worker: Worker<MintConfirmationJob> | undefined;

  constructor(
    connection: ConnectionOptions,
    private readonly chainServices: Map<number, ChainServices>,
    private readonly ledger: NftLedgerService,
    private readonly logger: Logger,
    private readonly vaultSettings?: VaultSettingsService,
    private readonly nftTransferService?: NftTransferService,
  ) {
    this.queue = new Queue<MintConfirmationJob>(QUEUE_NAME, { connection });
  }

  /** Fire-and-forget: the caller does not await this delaying its own response. */
  async enqueue(job: MintConfirmationJob): Promise<void> {
    await this.queue.add('confirm', job, {
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: FIRST_RETRY_MS },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 86_400 },
    });
  }

  /** Starts the worker that processes confirmation jobs. Call once at startup. */
  startWorker(connection: ConnectionOptions): void {
    if (this.worker) return;
    this.worker = new Worker<MintConfirmationJob>(
      QUEUE_NAME,
      async (job: Job<MintConfirmationJob>) =>
        processConfirmationJob(this.chainServices, this.ledger, this.logger, job.data, this.vaultSettings, this.nftTransferService, {
          recorded: (tokens) => job.updateData({ ...job.data, recorded: tokens }),
        }),
      // A mint that is slow to land holds its slot for the whole wait: it must not hold up the others.
      { connection, concurrency: 10 },
    );
    this.worker.on('failed', (job, err) => {
      const left = job ? (job.opts.attempts ?? 1) - job.attemptsMade : 0;
      if (left > 0) this.logger.info('mint confirmation: not settled yet, will look again', { jobId: job?.id, triesLeft: left, message: err.message });
      else this.logger.error('mint confirmation: gave up', { jobId: job?.id, hash: job?.data.hash, walletId: job?.data.walletId, message: err.message });
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

/** The confirm-then-record logic as an exported function, so it is testable without a live queue. */
export async function processConfirmationJob(
  chainServices: Map<number, ChainServices>,
  ledger: NftLedgerService,
  logger: Logger,
  data: MintConfirmationJob,
  vaultSettings?: VaultSettingsService,
  nftTransferService?: NftTransferService,
  checkpoint?: { recorded: (tokens: { tokenId: string; amount: string }[]) => Promise<unknown> },
): Promise<void> {
  const chain = chainServices.get(data.chainId);
  if (!chain) {
    logger.error('mint confirmation: no chain services for this chainId', { chainId: data.chainId });
    return;
  }

  let tokens = data.recorded;
  if (!tokens) {
    // Throws while the mint is not mined (or the chain cannot be read): the job is tried again.
    const confirmed = await chain.transactionEngine.waitForConfirmation(data.hash, data.nonce);
    if (confirmed.status !== 'confirmed') {
      logger.info('mint confirmation: reverted on-chain, nothing minted', { hash: data.hash, walletId: data.walletId });
      return;
    }

    tokens = parseMintedTokens(confirmed.receipt, data.standard, data.walletAddress, data.contract);
    if (tokens.length === 0) {
      logger.info('mint confirmation: no Transfer log found for this wallet', { hash: data.hash, walletId: data.walletId });
      return;
    }

    await ledger.recordMint(
      { walletId: data.walletId, ownerId: data.ownerId, chainId: data.chainId, contract: data.contract, standard: data.standard },
      tokens,
    );
    // From here a retry must not write the rows again.
    await checkpoint?.recorded(tokens);
    logger.info('mint confirmed, ledger updated', {
      walletId: data.walletId,
      chainId: data.chainId,
      contract: data.contract,
      count: tokens.length,
    });
  }

  if (!vaultSettings || !nftTransferService) return;
  const setting = await vaultSettings.get(data.ownerId, data.chainId);
  if (!setting.enabled || !setting.vaultAddress) return;

  const notMoved = async (tokenId: string, reason: string) => {
    await ledger.recordDrainFailure({ chainId: data.chainId, contract: data.contract, tokenId, walletId: data.walletId }, reason);
    logger.error('vault auto-drain failed for a minted token', { walletId: data.walletId, chainId: data.chainId, contract: data.contract, tokenId, error: reason });
  };

  let outcome: Awaited<ReturnType<NftTransferService['transfer']>>;
  try {
    outcome = await nftTransferService.transfer({
      ownerId: data.ownerId,
      chainId: data.chainId,
      destination: setting.vaultAddress as `0x${string}`,
      items: tokens.map((t) => ({ walletId: data.walletId, contract: data.contract, tokenId: t.tokenId, standard: data.standard, amount: t.amount })),
      onReverted: (item, hash) => notMoved(item.tokenId, `The transfer to the vault was sent but reverted on the chain (${hash}).`),
    });
  } catch (err) {
    for (const t of tokens) await notMoved(t.tokenId, chainErrorText(err));
    return;
  }

  // Refused before anything was sent (the vault is one of the owner's own minting wallets, ...).
  if (outcome.preflightError) {
    for (const t of tokens) await notMoved(t.tokenId, outcome.detail ?? `Not moved: ${outcome.preflightError}`);
    return;
  }

  for (const result of outcome.results) {
    if (result.status === 'sent') continue;
    // The chain says the wallet no longer holds it: moved by hand already.
    if (result.status === 'skipped') {
      logger.info('vault auto-drain: token already gone from the wallet', { walletId: data.walletId, chainId: data.chainId, contract: data.contract, tokenId: result.tokenId });
      continue;
    }
    await notMoved(result.tokenId, result.error ?? 'Unknown error');
  }
}
