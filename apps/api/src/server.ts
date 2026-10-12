import 'dotenv/config';
import Redis from 'ioredis';
import { appOrigins, loadConfig } from '@stryx/config';
import { createLogger } from '@stryx/logger';
import { getPrismaClient, disconnectPrisma, checkMigrations, createPrismaClient } from '@stryx/database';
import { migrationGate } from './migration-gate.js';
import { PrismaPlatformStatsRepository } from './platform-stats.js';
import { PrismaWalletRepository, WalletService } from '@stryx/wallet-service';
import { PrismaUserRepository, UserAccountService } from '@stryx/user-service';
import { WalletKeyService } from '@stryx/key-management';
import { InProcessEventBus } from '@stryx/event-bus';
import { buildApp } from './app.js';
import { applyNetworkDefaults } from './network-defaults.js';
import { RedisSessionStore } from './session-store.js';
import { SiweService } from './siwe-service.js';
import { PrismaMintEventRepository, type MintEventDelegate } from './mint-event-log.js';
import { MintEventSettler, type ReceiptReader } from './mint-event-settler.js';
import { AccessCodeService } from './access-code-service.js';
import { PrismaIdentityRepository, type IdentityPrismaClient } from './identity-repository.js';
import { SessionCookie } from './session-cookie.js';
import { RedisRateLimiter } from './rate-limiter.js';
import { PrismaWaitlistRepository, WaitlistService, type WaitlistPrismaClient } from './waitlist.js';
import { landingUrl, ResendMailer, STRYX_X_URL } from './invite-email.js';
import { PrismaTermsRepository, TermsService, type TermsPrismaClient } from './terms.js';
import { PrismaAuditLogRepository } from './audit-log-repository.js';
import { AuditLogService } from './audit-log-service.js';
import { createKeyManagementProvider } from './kms-provider.js';
import { EmergencyStopGuard } from '@stryx/transaction-engine';
import { buildChainServicesRegistry } from './chain-services.js';
import { RedisAdapter } from './redis-adapter.js';
import { InMemoryAllowListStore } from './allowlist-store.js';
import { MintExecutionService } from './mint-execution.service.js';
import { MintPreviewService } from './mint-preview.service.js';
import { MintBatchService } from './mint-batch.service.js';
import { SpendCapResolver, parsePerChainCaps } from './spend-cap-resolver.js';
import { MintScheduler } from './mint-scheduler.js';
import { AutoScheduleService } from './auto-schedule.service.js';
import { OpenSeaResolver } from './opensea-resolver.js';
import { DropsFeedService } from './drops-feed.service.js';
import { PENDING_JOB_STATES, makeNftHoldingsCheck } from './wallet-deletion.js';
import { bullConnectionFrom } from './bull-connection.js';
import { timedFetch } from './timed-fetch.js';
import { OpenSeaDropClient } from './opensea-drop-client.js';
import { CachingOpenSeaDropClient } from './opensea-proof-cache.js';
import { fetchOpenSeaDropInfoResult } from './opensea-drop-info.js';
import { OpenSeaDropInfoCache } from './opensea-drop-info-cache.js';
import { chainById, testnetsSwitchedOff, unrecognizedRpcEnvKeys } from './chain-registry.js';
import { BalanceService } from './balance.service.js';
import { DisperseService } from './disperse.service.js';
import { WalletKeyRecordProviderAdapter } from './wallet-key-record-provider.js';
import { loadOpenSeaEligibilitySource } from './opensea-eligibility-source.js';
import { MintEligibilityService } from './mint-eligibility.service.js';
import { PrismaNftLedgerRepository } from './nft-ledger-repository.js';
import { NftLedgerService } from './nft-ledger.service.js';
import { MintConfirmationWatcher } from './mint-confirmation-watcher.js';
import { AlchemyNftHoldingsProvider, NftHoldingsService, deriveAlchemyNftApiBase } from './nft-holdings.service.js';
import { NftTransferService } from './nft-transfer.service.js';
import { rpcUrlFor } from './chain-registry.js';
import { PrismaVaultSettingsRepository } from './vault-settings-repository.js';
import { VaultSettingsService } from './vault-settings.service.js';
import { StepUpStore } from './step-up-store.js';
import { WalletKeyExportService } from './wallet-key-export.service.js';
import { OpenSeaSignedMintClient } from './opensea-signed-mint-client.js';
import { PrismaSignedMintRepository } from './signed-mint-repository.js';
import { RedisSignedMintFlags, SignedMintRunner } from './signed-mint-runner.js';
import { SignedMintScheduler } from './signed-mint-scheduler.js';
import { resolveSignedStage } from './signed-mint-start-resolver.js';
import { RESERVED_OPERATOR_USER_ID } from './reserved-users.js';

// IPv4 first, longer connection attempts: see network-defaults.ts.
applyNetworkDefaults();

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ service: 'api', pretty: config.NODE_ENV !== 'production' });

  // Refuse to start without an auth token outside tests.
  if (!config.API_AUTH_TOKEN) {
    throw new Error(
      'API_AUTH_TOKEN is not set. The API will not start without it: a missing token would leave every endpoint open. Set API_AUTH_TOKEN in your environment.',
    );
  }

  // ADR-002 §3.10: connect as the lower-privileged `stryx_app` role when configured, so the app's own
  // process cannot UPDATE or DELETE audit_log.
  if (!config.RUNTIME_DATABASE_URL) {
    logger.warn(
      'RUNTIME_DATABASE_URL is not set, connecting with DATABASE_URL instead, which almost ' +
        'certainly has full UPDATE/DELETE rights on audit_log. Audit-log tamper-resistance ' +
        '(ADR-002 §3.10) is NOT enforced until this is set to the restricted "stryx_app" role ' +
        '(see the provision_app_role migration and .env.example).',
    );
  }
  const prisma = getPrismaClient(config.RUNTIME_DATABASE_URL);
  // Refuse to start on a database that is behind this build, with one line saying what to run.
  const gate = migrationGate(await checkMigrations(prisma), config.ALLOW_PENDING_MIGRATIONS);
  logger[gate.level](gate.message);
  if (!gate.start) {
    await disconnectPrisma();
    process.exit(1);
  }
  const walletRepository = new PrismaWalletRepository(prisma.wallet);

  const kms = createKeyManagementProvider(config);
  const walletKeyService = new WalletKeyService(kms, logger);
  const walletService = new WalletService(walletRepository, walletKeyService, kms.keyId, logger);

  const redis = new Redis(config.REDIS_URL);
  // OpenSea and Alchemy reads: a server that stalls is given up on, not waited on for minutes.
  const boundedFetch = timedFetch();
  // The Home feed's snapshot is kept in Redis, so a restart does not make the next visitor wait for
  // OpenSea.
  const dropsFeedService = new DropsFeedService(boundedFetch, config.OPENSEA_API_KEY, {
    store: {
      load: () => redis.get('home-feed:snapshot'),
      save: async (value) => void (await redis.set('home-feed:snapshot', value, 'EX', 24 * 60 * 60)),
    },
  });

  // A misnamed RPC variable leaves its chain silently off; say so loudly (names only, never URLs).
  for (const { key, didYouMean } of unrecognizedRpcEnvKeys(process.env)) {
    logger.warn(`${key} is set but no chain reads it${didYouMean ? `; did you mean ${didYouMean}?` : ''}`, { key });
  }
  for (const chain of testnetsSwitchedOff(config)) {
    logger.warn(`${chain.name} has an RPC set but testnets are off (ENABLE_TESTNETS); it is not offered`, { chainId: chain.chainId });
  }
  const chainServices = buildChainServicesRegistry(config, redis, walletKeyService, walletRepository, logger);
  if (chainServices.size === 0) {
    logger.warn('no chains configured: set an RPC_<CHAIN> URL (e.g. RPC_BASE) to enable minting');
  }

  // The emergency-stop guard and its routes.
  const emergencyStopGuard = new EmergencyStopGuard(new RedisAdapter(redis));

  // Built before mint and disperse, which both need SpendCapResolver.
  const userRepository = new PrismaUserRepository(prisma.user);
  const userAccountService = new UserAccountService(userRepository);
  const sessions = new RedisSessionStore(redis);
  const spendCapResolver = new SpendCapResolver(
    userAccountService,
    config.DEFAULT_DAILY_SPEND_CAP_WEI ? BigInt(config.DEFAULT_DAILY_SPEND_CAP_WEI) : undefined,
    parsePerChainCaps(config.DEFAULT_DAILY_SPEND_CAPS),
    config.WALLET_DAILY_SPEND_SHARE_PERCENT,
  );

  const allowListStore = new InMemoryAllowListStore();
  // Cached: eligibility checks and "max" quantity resolution ask OpenSea the same (slug, address)
  // question.
  const openSeaDropClient = new CachingOpenSeaDropClient(
    new OpenSeaDropClient(boundedFetch, config.OPENSEA_API_KEY),
  );

  // BullMQ manages its own connections, built from the same REDIS_URL.
  const bullConnection = bullConnectionFrom(config.REDIS_URL);

  // The mint ledger (which tokenId each mint produced) and the confirmation watcher that fills it.
  const nftLedgerService = new NftLedgerService(new PrismaNftLedgerRepository(prisma.mintedNft), logger);
  const nftTransferService = new NftTransferService(walletService, chainServices, nftLedgerService);
  const vaultSettingsService = new VaultSettingsService(new PrismaVaultSettingsRepository(prisma.vaultSetting));
  const mintConfirmationWatcher = new MintConfirmationWatcher(
    bullConnection,
    chainServices,
    nftLedgerService,
    logger,
    vaultSettingsService,
    nftTransferService,
  );
  mintConfirmationWatcher.startWorker(bullConnection);

  // Shared by /auth/step-up and every route that requires a step-up.
  const stepUpStore = new StepUpStore(redis);
  const walletKeyExportService = new WalletKeyExportService(walletService, walletKeyService, new WalletKeyRecordProviderAdapter(walletRepository));

  // The mint log (ADR-003 §4.9): the server's record of every mint, what Activity reads on any device.
  const mintEventRepository = new PrismaMintEventRepository(prisma.mintEvent as unknown as MintEventDelegate);

  const mintExecutionService = new MintExecutionService(
    walletService,
    chainServices,
    allowListStore,
    openSeaDropClient,
    spendCapResolver,
    mintConfirmationWatcher,
    { repository: mintEventRepository, logger },
  );
  const mintPreviewService = new MintPreviewService(walletService, chainServices, mintExecutionService);
  const mintBatchService = new MintBatchService(walletService, chainServices, mintExecutionService);

  // Reuses the shared ioredis connection for the per-owner job index.
  const mintScheduler = new MintScheduler(bullConnection, mintExecutionService, logger, redis, chainServices);
  mintScheduler.startWorker(bullConnection);

  // One Alchemy NFT-holdings provider per chain whose RPC is Alchemy's, derived from the RPC URL in
  // use.
  const alchemyNftProviders = new Map(
    [...chainServices.keys()]
      .map((chainId) => [chainId, rpcUrlFor(config, chainId)] as const)
      .filter((pair): pair is [number, string] => pair[1] !== undefined)
      .map(([chainId, url]) => [chainId, deriveAlchemyNftApiBase(url)] as const)
      .filter((pair): pair is [number, string] => pair[1] !== null)
      .map(([chainId, apiBase]) => [chainId, new AlchemyNftHoldingsProvider(apiBase, boundedFetch)] as const),
  );
  const nftHoldingsService = new NftHoldingsService(walletService, nftLedgerService, alchemyNftProviders);

  const autoScheduleService = new AutoScheduleService(chainServices, mintScheduler, logger);

  const openSeaResolver = new OpenSeaResolver(
    boundedFetch,
    config.OPENSEA_API_KEY,
  );

  // Best-effort drop enrichment from OpenSea for GET /drops/:chainId/:contract.
  const dropInfoCache = new OpenSeaDropInfoCache((chainId, contract) => {
    const openSeaChainName = chainById(chainId)?.openSeaChainName;
    if (!openSeaChainName) return Promise.resolve({ status: 'not_listed' as const });
    return fetchOpenSeaDropInfoResult(boundedFetch, config.OPENSEA_API_KEY, openSeaChainName, contract);
  });
  const fetchDropInfoReading = (chainId: number, contract: string) => dropInfoCache.get(chainId, contract);
  const fetchDropInfo = (chainId: number, contract: string) => dropInfoCache.get(chainId, contract).then((r) => r.info);

  const balanceService = new BalanceService(chainServices);
  const disperseService = new DisperseService(walletService, chainServices, spendCapResolver);

  // Signed-stage eligibility is off unless the flag is set and its optional module is present.
  const openSeaEligibility = config.OPENSEA_SIGNED_MINT_ELIGIBILITY_ENABLED
    ? await loadOpenSeaEligibilitySource(
        { fetch: boundedFetch, openSeaApiKey: config.OPENSEA_API_KEY, redis, kms, walletKeyService, walletKeyRecords: new WalletKeyRecordProviderAdapter(walletRepository) },
        logger,
      )
    : null;
  const mintEligibilityService = new MintEligibilityService(walletService, chainServices, mintExecutionService, openSeaEligibility);

  // ADR-002 §3.10: each audit entry is also published to the event bus.
  const auditLogService = new AuditLogService(
    new PrismaAuditLogRepository(prisma.auditLog),
    new InProcessEventBus(),
    logger,
    // The operator token's own entries stay as their caller wrote them: what it may do is a setting,
    // not that row's role.
    async (userId) => (userId === RESERVED_OPERATOR_USER_ID ? null : ((await userRepository.findById(userId))?.role ?? null)),
  );

  // Signed stages, scheduled ahead of time, using only OpenSea's documented drop endpoints.
  const openSeaSignedMintClient = new OpenSeaSignedMintClient((url, init) => fetch(url, init), config.OPENSEA_API_KEY);
  const signedMintRepository = new PrismaSignedMintRepository(prisma.signedMintRun, prisma.signedMintAttempt);
  const signedMintFlags = new RedisSignedMintFlags(redis);
  const resolveStage = (params: { slug: string; stageUuid: string; chainId: number; contract: `0x${string}` }) => {
    const chain = chainServices.get(params.chainId);
    if (!chain) return Promise.resolve({ ok: false as const, reason: 'rpc_unavailable' as const, detail: `No RPC configured for chain ${params.chainId}.` });
    return resolveSignedStage(openSeaSignedMintClient, chain.seaDropReader, params);
  };
  const signedMintRunner = new SignedMintRunner({
    walletService,
    chainServices,
    openSea: openSeaSignedMintClient,
    repository: signedMintRepository,
    flags: signedMintFlags,
    spendCapResolver,
    confirmationWatcher: mintConfirmationWatcher,
    auditLogService,
    executionEnabled: config.SIGNED_MINT_EXECUTION_ENABLED,
    openSeaConcurrency: config.SIGNED_MINT_OPENSEA_CONCURRENCY,
    overlap: { intervalMs: config.SIGNED_MINT_OVERLAP_MS, maxInFlight: config.SIGNED_MINT_MAX_IN_FLIGHT },
    holdKeys: config.SIGNED_MINT_HOLD_KEYS,
    logger,
  });
  const signedMintScheduler = new SignedMintScheduler(bullConnection, signedMintRunner, signedMintRepository, signedMintFlags, redis, logger, {
    resolveStage: (data) => resolveStage({ slug: data.slug, stageUuid: data.stageUuid, chainId: data.chainId, contract: data.nftContract }),
    mintLog: mintEventRepository,
  });
  signedMintScheduler.startWorker(bullConnection);
  signedMintScheduler.startRecheck();
  if (config.SIGNED_MINT_HOLD_KEYS) {
    logger.warn('SIGNED_MINT_HOLD_KEYS is on: during a signed-mint job each wallet\'s unlocked data key is held in memory until it has sent');
  }
  if (!config.SIGNED_MINT_EXECUTION_ENABLED) {
    logger.info('signed-mint execution is OFF (SIGNED_MINT_EXECUTION_ENABLED=false): signed stages cannot be scheduled or fired');
  }

  // Settles PENDING mints from the chain every 20s, with no dashboard open.
  const mintEventSettler = new MintEventSettler(
    mintEventRepository,
    new Map([...chainServices].map(([chainId, services]) => [chainId, services.publicClient as unknown as ReceiptReader])),
    logger,
  );
  mintEventSettler.start();

  // What the operator API token may do (ADR-003 §4.10).
  const operatorTokenMode = config.OPERATOR_TOKEN_MODE ?? (config.NODE_ENV === 'production' ? 'off' : 'admin');
  logger.info('operator API token', { mode: operatorTokenMode });
  if (operatorTokenMode !== 'admin' && !(config.APP_ORIGIN && config.ACCESS_CODE_SECRET)) {
    logger.warn('the operator API token cannot act as admin and wallet sign-in is off (APP_ORIGIN is not set), so nobody can reach the admin pages. Set APP_ORIGIN and ACCESS_CODE_SECRET, or OPERATOR_TOKEN_MODE=admin.');
  }
  // The operator Overview reads through its own read-only role when one is configured (ADR-003 §4.11).
  const analyticsPrisma = config.ANALYTICS_DATABASE_URL ? createPrismaClient(config.ANALYTICS_DATABASE_URL) : null;
  logger.info('operator analytics queries', { role: analyticsPrisma ? 'read-only analytics role' : 'runtime role (set ANALYTICS_DATABASE_URL to use the read-only role)' });
  const app = buildApp({
    walletService,
    logger,
    mintLog: mintEventRepository,
    platformStats: new PrismaPlatformStatsRepository(analyticsPrisma ?? prisma),
    adminViewLimiter: new RedisRateLimiter(redis, 'ratelimit', config.ACCESS_CODE_SECRET),
    authToken: config.API_AUTH_TOKEN,
    operatorTokenMode,
    balanceService,
    // Deleting a wallet is refused while a scheduled mint uses it, and allowed with funds in it only
    // when its key exists elsewhere.
    walletDeletion: {
      scheduledUses: async (ownerId, walletId) => {
        const [plain, signed] = await Promise.all([mintScheduler.list({ ownerId }), signedMintScheduler.list({ ownerId })]);
        return (
          plain.filter((j) => j.walletId === walletId && PENDING_JOB_STATES.has(j.state)).length +
          signed.filter((j) => PENDING_JOB_STATES.has(j.state) && j.wallets.some((w) => w.walletId === walletId)).length
        );
      },
      getNftHoldings: makeNftHoldingsCheck({
        chains: [...chainServices].map(([chainId, services]) => {
          const indexer = alchemyNftProviders.get(chainId);
          return { chainId, chainName: chainById(chainId)?.name ?? `Chain ${chainId}`, publicClient: services.publicClient, ...(indexer ? { indexer } : {}) };
        }),
        ledger: nftLedgerService,
      }),
      keyExported: async (walletId) => (await prisma.auditLog.findFirst({ where: { action: 'wallet.export_key', walletId, outcome: 'SUCCESS' }, select: { id: true } })) !== null,
    },
    disperseService,
    fetchOpenSeaDropInfo: fetchDropInfo,
    fetchOpenSeaDropInfoReading: fetchDropInfoReading,
    // Home page feed: built on demand and cached, never on a timer (see drops-feed.service.ts).
    dropsFeedService,
    ...(config.COINGECKO_API_KEY ? { coinGeckoApiKey: config.COINGECKO_API_KEY } : {}),
    mintExecutionService,
    mintPreviewService,
    mintBatchService,
    mintScheduler,
    autoScheduleService,
    mintEligibilityService,
    // Anything held for a wallet by the eligibility source goes with the wallet.
    onWalletDeleted: async (walletId) => {
      await openSeaEligibility?.forget(walletId);
    },
    openSeaResolver,
    chainServices,
    userAccountService,
    sessions,
    auditLogService,
    emergencyStopGuard,
    userRepository,
    signupEnabled: config.SIGNUP_ENABLED,
    nftHoldingsService,
    nftTransferService,
    stepUpStore,
    vaultSettingsService,
    nftLedgerService,
    walletKeyExportService,
    trustProxy: config.TRUST_PROXY,
    // Terms acceptance: on only when TERMS_VERSION and PRIVACY_VERSION are both set (loadConfig insists on both).
    terms: new TermsService(
      new PrismaTermsRepository(prisma as unknown as TermsPrismaClient),
      config.TERMS_VERSION && config.PRIVACY_VERSION ? { termsVersion: config.TERMS_VERSION, privacyVersion: config.PRIVACY_VERSION } : null,
      config.ACCESS_CODE_SECRET,
    ),
    waitlist: { service: new WaitlistService(new PrismaWaitlistRepository(prisma as unknown as WaitlistPrismaClient)), limiter: new RedisRateLimiter(redis, 'ratelimit', config.ACCESS_CODE_SECRET) },
    // Waitlist invites by email: on only with RESEND_API_KEY, and used only with invite codes (APP_ORIGIN).
    ...(config.RESEND_API_KEY && config.APP_ORIGIN
      ? {
          inviteEmail: {
            mailer: new ResendMailer(config.RESEND_API_KEY, config.INVITE_EMAIL_FROM, config.INVITE_EMAIL_REPLY_TO ?? null),
            siteUrl: landingUrl(config.SITE_URL, appOrigins(config)[0]!),
            xUrl: STRYX_X_URL,
          },
        }
      : {}),
    // Wallet sign-in and invite codes: on only when APP_ORIGIN is set.
    ...(config.APP_ORIGIN && config.ACCESS_CODE_SECRET
      ? (() => {
          const identity = new PrismaIdentityRepository(prisma as unknown as IdentityPrismaClient);
          return {
            walletSignIn: {
              appOrigin: appOrigins(config),
              siwe: new SiweService(redis, appOrigins(config)),
              codes: new AccessCodeService(identity, redis, config.ACCESS_CODE_SECRET),
              identity,
              sessionCookie: new SessionCookie(appOrigins(config)[0]!),
              limiter: new RedisRateLimiter(redis, 'ratelimit', config.ACCESS_CODE_SECRET),
            },
          };
        })()
      : {}),
    signedMint: {
      scheduler: signedMintScheduler,
      repository: signedMintRepository,
      walletService,
      resolveStage,
      executionEnabled: config.SIGNED_MINT_EXECUTION_ENABLED,
      retryIntervalMs: config.SIGNED_MINT_RETRY_INTERVAL_MS,
      giveUpMs: config.SIGNED_MINT_GIVE_UP_MS,
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await app.close();
    mintEventSettler.stop();
    await mintScheduler.close();
    await signedMintScheduler.close();
    await mintConfirmationWatcher.close();
    await analyticsPrisma?.$disconnect();
    await disconnectPrisma();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // HOST=:: fails on a machine with IPv6 switched off: listen on every IPv4 interface instead, and say
  // so.
  let host = config.HOST;
  try {
    await app.listen({ port: config.PORT, host });
  } catch (err) {
    if (host !== '::' || (err as NodeJS.ErrnoException).code !== 'EAFNOSUPPORT') throw err;
    logger.warn('HOST=:: but this machine has no IPv6: listening on 0.0.0.0 (IPv4) instead');
    host = '0.0.0.0';
    await app.listen({ port: config.PORT, host });
  }
  logger.info('api listening', {
    host,
    port: config.PORT,
    kmsProvider: config.KMS_PROVIDER,
    chains: [...chainServices.keys()],
  });
  // Have the Home feed ready before the first visitor asks (background; never delays startup).
  void dropsFeedService.warm().catch(() => undefined);
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup', err);
  process.exit(1);
});
