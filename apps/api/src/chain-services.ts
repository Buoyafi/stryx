import type { PublicClient } from 'viem';
import type Redis from 'ioredis';
import type { AppConfig } from '@stryx/config';
import type { Logger } from '@stryx/logger';
import { NonceManager, ViemChainNonceReader } from '@stryx/nonce-manager';
import { WalletKeyService } from '@stryx/key-management';
import type { WalletRepository } from '@stryx/wallet-service';
import { SeaDropReader } from '@stryx/nft-engine';
import {
  TransactionEngine,
  EmergencyStopGuard,
  SpendingCapGuard,
  GasEstimator,
  TransactionSimulator,
  TransactionSigner,
} from '@stryx/transaction-engine';
import { parseGwei } from 'viem';
import { chainById } from '@stryx/chains';
import { configuredChainIds, createChainPublicClient, createRaceBroadcaster } from './rpc-client-factory.js';
import { WalletKeyRecordProviderAdapter } from './wallet-key-record-provider.js';
import { RedisAdapter } from './redis-adapter.js';
import { SeaDropSupport } from './seadrop-support.js';

export interface ChainServices {
  seaDropReader: SeaDropReader;
  transactionEngine: TransactionEngine;
  /** The chain's RPC client. Exposed for direct reads (e.g. native balances) that don't belong to a specific engine. */
  publicClient: PublicClient;
  /** Whether SeaDrop exists on this chain (see seadrop-support.ts). Optional: absent means "assume yes" (test fakes). */
  seaDropSupport?: SeaDropSupport;
  /** Opens a connection to every endpoint a send goes to. Set only when sends race two endpoints. */
  warmBroadcast?: () => void;
}

/** Builds the chain services (SeaDrop reader, transaction engine) for every chain with an RPC URL configured. */
export function buildChainServicesRegistry(
  config: AppConfig,
  redis: Redis,
  walletKeyService: WalletKeyService,
  walletRepository: WalletRepository,
  logger: Logger,
): Map<number, ChainServices> {
  const redisAdapter = new RedisAdapter(redis);
  const emergencyStopGuard = new EmergencyStopGuard(redisAdapter);
  const spendingCapGuard = new SpendingCapGuard(redisAdapter);
  const signer = new TransactionSigner(walletKeyService, new WalletKeyRecordProviderAdapter(walletRepository));

  const registry = new Map<number, ChainServices>();

  for (const chainId of configuredChainIds(config)) {
    const publicClient = createChainPublicClient(config, chainId, logger);
    const nonceManager = new NonceManager(redisAdapter, new ViemChainNonceReader(publicClient), {}, logger);
    const race = createRaceBroadcaster(config, chainId, publicClient, logger);

    const transactionEngine = new TransactionEngine(
      nonceManager,
      emergencyStopGuard,
      spendingCapGuard,
      new GasEstimator(publicClient, minPriorityFeeWei(chainId), gasBufferPercent(chainId)),
      new TransactionSimulator(publicClient),
      signer,
      publicClient,
      logger,
      race ? (tx) => race.send(tx) : undefined,
    );

    registry.set(chainId, {
      seaDropReader: new SeaDropReader(publicClient),
      transactionEngine,
      publicClient,
      seaDropSupport: new SeaDropSupport(publicClient),
      ...(race ? { warmBroadcast: () => race.warm() } : {}),
    });

    logger.info('chain services registered', { chainId });
  }

  return registry;
}

/** The chain's own minimum tip (Polygon: 25 gwei), as wei, or null when it has none. */
export function minPriorityFeeWei(chainId: number): bigint | null {
  const gwei = chainById(chainId)?.feeMarket.minPriorityFeeGwei ?? null;
  return gwei === null ? null : parseGwei(String(gwei));
}

/** How far a gas estimate is padded, in percent. */
export function gasBufferPercent(chainId: number): bigint {
  return chainById(chainId)?.feeMarket.chargesGasLimit ? 110n : 120n;
}
