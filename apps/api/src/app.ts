import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { DecryptionIntegrityError, KmsOperationError } from '@stryx/key-management';
import { walletController, WalletNotFoundError, type WalletService } from '@stryx/wallet-service';
import type { UserAccountService, UserRepository } from '@stryx/user-service';
import type { EmergencyStopGuard } from '@stryx/transaction-engine';
import type { Logger } from '@stryx/logger';
import { registerAuth, type OperatorTokenMode } from './auth.js';
import { adminOverviewController } from './admin-overview-controller.js';
import type { PlatformStatsRepository } from './platform-stats.js';
import { RESERVED_OPERATOR_USER_ID } from './reserved-users.js';
import { mintController } from './mint-controller.js';
import { allowListMintController } from './allowlist-mint-controller.js';
import { mintPreviewController } from './mint-preview-controller.js';
import { mintBatchController } from './mint-batch-controller.js';
import { scheduleController } from './schedule-controller.js';
import { resolveController } from './resolve-controller.js';
import { walletOpsController } from './wallet-ops-controller.js';
import { userAuthController } from './user-auth-controller.js';
import { walletAuthController } from './wallet-auth-controller.js';
import { mintHistoryController } from './mint-history-controller.js';
import type { MintEventRepository } from './mint-event-log.js';
import type { SiweService } from './siwe-service.js';
import type { AccessCodeService } from './access-code-service.js';
import type { IdentityRepository } from './identity-repository.js';
import type { SessionCookie } from './session-cookie.js';
import type { RedisRateLimiter } from './rate-limiter.js';
import { emergencyStopController } from './emergency-stop-controller.js';
import type { MintExecutionService } from './mint-execution.service.js';
import type { MintPreviewService } from './mint-preview.service.js';
import type { MintBatchService } from './mint-batch.service.js';
import type { MintScheduler } from './mint-scheduler.js';
import type { AutoScheduleService } from './auto-schedule.service.js';
import type { OpenSeaResolver } from './opensea-resolver.js';
import type { ChainServices } from './chain-services.js';
import type { BalanceService } from './balance.service.js';
import type { DisperseService } from './disperse.service.js';
import type { RedisSessionStore } from './session-store.js';
import type { AuditLogService } from './audit-log-service.js';
import type { OpenSeaDropInfo } from './opensea-drop-info.js';
import type { DropInfoReading } from './opensea-drop-info-cache.js';
import { registerResponseRedaction } from './response-redaction.js';
import { GasPriceService } from './gas-price.service.js';
import { gasPriceController } from './gas-price-controller.js';
import { tipSuggestionController } from './tip-suggestion-controller.js';
import { TipSuggestionService } from './tip-suggestion.service.js';
import { ViemTipChainReader } from './tip-suggestion-reader.js';
import { CollectionResolverService } from './collection-resolver.service.js';
import { CollectionImageService } from './collection-image.service.js';
import { CollectionSupplyService } from './collection-supply.service.js';
import { collectionResolveController } from './collection-resolve-controller.js';
import { NativePriceService, createCoinGeckoNativePriceReader } from './native-price.service.js';
import { nativePriceController } from './native-price-controller.js';
import type { MintEligibilityService } from './mint-eligibility.service.js';
import { mintEligibilityController } from './mint-eligibility-controller.js';
import type { NftHoldingsService } from './nft-holdings.service.js';
import type { NftTransferService } from './nft-transfer.service.js';
import type { NftLedgerService } from './nft-ledger.service.js';
import type { VaultSettingsService } from './vault-settings.service.js';
import type { StepUpStore } from './step-up-store.js';
import { stepUpController } from './step-up-controller.js';
import { vaultController } from './vault-controller.js';
import type { WalletKeyExportService } from './wallet-key-export.service.js';
import { keyExportController } from './key-export-controller.js';
import { signedMintController, type SignedMintControllerDeps } from './signed-mint-controller.js';
import type { DropsFeedService } from './drops-feed.service.js';
import { makeWalletDeletionChecker, type WalletDeletionDeps } from './wallet-deletion.js';
import { homeController } from './home-controller.js';
import { waitlistController } from './waitlist-controller.js';
import { termsController, registerTermsGate } from './terms-controller.js';
import type { TermsService } from './terms.js';
import type { WaitlistService } from './waitlist.js';
import type { Mailer } from './invite-email.js';
import { credentialActorType } from './audit-actor.js';

export interface AppDependencies {
  walletService: WalletService;
  logger: Logger;
  /** Level 1 auth token. When set, every non-public route requires it. Tests omit it. */
  authToken?: string;
  /** What the operator API token may do (auth.ts). Defaults to 'admin', as before modes existed. */
  operatorTokenMode?: OperatorTokenMode;
  /** Optional so tests that do not exercise minting need no chain setup. */
  mintExecutionService?: MintExecutionService;
  /** Optional; only meaningful alongside mintExecutionService. */
  mintPreviewService?: MintPreviewService;
  /** Optional. When present, POST /mints/seadrop/batch is registered. */
  mintBatchService?: MintBatchService;
  /** Optional. When present, the schedule/cancel endpoints are registered. */
  mintScheduler?: MintScheduler;
  /** What deleting a wallet checks besides balances: scheduled mints that use it, and whether its key was exported. */
  walletDeletion?: Pick<WalletDeletionDeps, 'scheduledUses' | 'keyExported' | 'getNftHoldings'>;
  autoScheduleService?: AutoScheduleService;
  /** Optional. When present, the OpenSea resolve endpoint is registered. */
  openSeaResolver?: OpenSeaResolver;
  /** Needed alongside openSeaResolver so resolve results can report mintability. */
  chainServices?: Map<number, ChainServices>;
  /** Optional. When both are present, the balances + disperse endpoints are registered. */
  balanceService?: BalanceService;
  disperseService?: DisperseService;
  /** Optional. Best-effort OpenSea enrichment for GET /drops/:chainId/:contract: see wallet-ops-controller.ts. */
  fetchOpenSeaDropInfo?: (chainId: number, contract: string) => Promise<OpenSeaDropInfo | null>;
  /** Optional: the same, with whether OpenSea answered (see OpenSeaDropInfoCache). Used by the phases route. */
  fetchOpenSeaDropInfoReading?: (chainId: number, contract: string) => Promise<DropInfoReading>;
  /** Optional CoinGecko demo API key for native USD prices; keyless works but is heavily rate-limited. */
  coinGeckoApiKey?: string;
  /**
   * Sign-up and login (ADR-002 §3.4). With `sessions`, the /auth routes are registered and session
   * tokens are accepted everywhere.
   */
  userAccountService?: UserAccountService;
  sessions?: RedisSessionStore;
  /** ADR-002 §3.10. Optional so tests that don't care about audit logging don't need Postgres/the event bus wired up. */
  auditLogService?: AuditLogService;
  /** Gates POST /auth/signup. Closed when omitted. */
  signupEnabled?: boolean;
  /** With `userRepository`, registers /emergency-stop/me and the /admin/emergency-stop routes. */
  emergencyStopGuard?: EmergencyStopGuard;
  userRepository?: UserRepository;
  /** Per-wallet, per-phase eligibility. Optional like the other mint services. */
  mintEligibilityService?: MintEligibilityService;
  /** When present, GET /wallets/:id/nfts is registered. */
  nftHoldingsService?: NftHoldingsService;
  /** Optional, alongside balanceService/disperseService: when present, POST /wallets/nfts/transfer is registered. */
  nftTransferService?: NftTransferService;
  /**
   * `stepUpStore` alone registers POST /auth/step-up; with `vaultSettingsService` and
   * `nftLedgerService` it also registers /vault-settings, whose PUT needs a live step-up grant.
   */
  stepUpStore?: StepUpStore;
  vaultSettingsService?: VaultSettingsService;
  nftLedgerService?: NftLedgerService;
  /** With stepUpStore: registers POST /wallets/:id/export-key (operator dashboard only). */
  walletKeyExportService?: WalletKeyExportService;
  /** Registers /signed-mints (schedule, list, cancel, report, status). */
  signedMint?: Omit<SignedMintControllerDeps, 'resolveOwnerId' | 'userRepository' | 'auditLogService'>;
  /** Optional. When present, GET /home/drops (the Home page feed) is registered. */
  dropsFeedService?: DropsFeedService;
  /**
   * Wallet sign-in and invite codes (APP_ORIGIN set): registers the /auth/code, /auth/siwe and
   * /admin/access-codes routes and accepts the session cookie.
   */
  walletSignIn?: {
    /** APP_ORIGIN: the dashboard origin, or several (the first is the main one). */
    appOrigin: string | readonly string[];
    siwe: SiweService;
    codes: AccessCodeService;
    identity: IdentityRepository;
    sessionCookie: SessionCookie;
    limiter: RedisRateLimiter;
  };
  /** The landing page waitlist (waitlist.ts). */
  waitlist?: { service: WaitlistService; limiter: RedisRateLimiter };
  /** Waitlist invites by email (RESEND_API_KEY set). */
  inviteEmail?: { mailer: Mailer; siteUrl: string; xUrl: string };
  /** Terms acceptance (terms.ts). */
  terms?: TermsService;
  /** The mint log (ADR-003 §4.9). When present, GET /me/mints is registered. */
  mintLog?: MintEventRepository;
  /** The operator Overview's numbers and lists (admin-overview-controller.ts). Needs userAccountService. */
  platformStats?: PlatformStatsRepository;
  /** Keeps the Overview's "admin viewed member records" audit rows to one per 10 minutes. */
  adminViewLimiter?: RedisRateLimiter;
  /** How many proxies in front of the API to trust for the visitor's address (TRUST_PROXY), so per-IP limits see visitors. */
  trustProxy?: number;
  /** Clears what is cached under a wallet's id once it is deleted. */
  onWalletDeleted?: (walletId: string) => Promise<void>;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  // Trust the nearest `hops` addresses only (the direct peer is hop 0).
  const hops = deps.trustProxy ?? 0;
  const app = Fastify({ trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false });

  // Registered first so it covers every route: no URL leaves in an error message.
  registerResponseRedaction(app, deps.logger);

  // auth.ts attaches request.userId to every authenticated request. The fallback is only for tests
  // that build the app without an auth token.
  const resolveOwnerId = (request: import('fastify').FastifyRequest) => request.userId ?? RESERVED_OPERATOR_USER_ID;

  // ADR-002 §3.10: the one place that turns "a request did X" into an audit entry.
  const recordAudit = async (
    request: import('fastify').FastifyRequest,
    event: { action: string; walletId?: string | null; targetUserId?: string | null; outcome: 'success' | 'failure'; detail?: string | null },
  ): Promise<void> => {
    if (!deps.auditLogService) return;
    const ownerId = resolveOwnerId(request);
    await deps.auditLogService.record({
      actorUserId: ownerId,
      actorType: credentialActorType(request),
      action: event.action,
      walletId: event.walletId ?? null,
      targetUserId: event.targetUserId ?? ownerId,
      outcome: event.outcome,
      detail: event.detail ?? null,
    });
  };

  // Auth is registered before routes so its hook guards every one of them.
  if (deps.authToken) {
    registerAuth(app, {
      expectedToken: deps.authToken,
      ...(deps.operatorTokenMode ? { tokenMode: deps.operatorTokenMode } : {}),
      operatorUserId: RESERVED_OPERATOR_USER_ID,
      ...(deps.sessions ? { sessions: deps.sessions } : {}),
      ...(deps.walletSignIn ? { sessionCookie: deps.walletSignIn.sessionCookie, appOrigin: deps.walletSignIn.appOrigin } : {}),
    });
  }

  // Right after the login check, on the root app, so it sees every route (terms-controller.ts).
  if (deps.terms) registerTermsGate(app, deps.terms);

  app.get('/health', async () => ({ status: 'ok' }));

  if (deps.userAccountService && deps.sessions) {
    void app.register(
      userAuthController({
        userAccountService: deps.userAccountService,
        sessions: deps.sessions,
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
        signupEnabled: deps.signupEnabled ?? false,
        ...(deps.walletSignIn ? { sessionCookie: deps.walletSignIn.sessionCookie, identity: deps.walletSignIn.identity } : {}),
      }),
    );
  }

  void app.register(
    walletController({
      walletService: deps.walletService,
      resolveOwnerId,
      recordAudit,
      ...(deps.onWalletDeleted ? { onWalletDeleted: deps.onWalletDeleted } : {}),
      // Deleting a wallet needs its balances on every chain, so it exists only when chains are set up.
      ...(deps.balanceService
        ? {
            checkDeletion: makeWalletDeletionChecker({
              getBalances: (address) => deps.balanceService!.getBalances(address),
              ...(deps.walletDeletion ?? {}),
            }),
          }
        : {}),
    }),
  );

  if (deps.mintExecutionService) {
    void app.register(
      mintController({
        mintExecutionService: deps.mintExecutionService,
        resolveOwnerId,
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
      }),
    );
    void app.register(
      allowListMintController({
        mintExecutionService: deps.mintExecutionService,
        resolveOwnerId,
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
      }),
    );
    if (deps.mintPreviewService) {
      void app.register(mintPreviewController({ mintPreviewService: deps.mintPreviewService, resolveOwnerId }));
    }
    if (deps.mintBatchService) {
      void app.register(
        mintBatchController({
          mintBatchService: deps.mintBatchService,
          resolveOwnerId,
          ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
        }),
      );
    }
  }

  if (deps.mintScheduler && deps.autoScheduleService) {
    void app.register(
      scheduleController({
        mintScheduler: deps.mintScheduler,
        autoScheduleService: deps.autoScheduleService,
        resolveOwnerId,
        ...(deps.userRepository ? { userRepository: deps.userRepository } : {}),
      }),
    );
  }

  if (deps.balanceService && deps.disperseService) {
    void app.register(
      walletOpsController({
        walletService: deps.walletService,
        balanceService: deps.balanceService,
        disperseService: deps.disperseService,
        configuredChainIds: [...(deps.chainServices?.keys() ?? [])],
        chainServicesMap: deps.chainServices ?? new Map(),
        resolveOwnerId,
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
        ...(deps.fetchOpenSeaDropInfo ? { fetchOpenSeaDropInfo: deps.fetchOpenSeaDropInfo } : {}),
        ...(deps.nftHoldingsService ? { nftHoldingsService: deps.nftHoldingsService } : {}),
        ...(deps.nftTransferService ? { nftTransferService: deps.nftTransferService } : {}),
      }),
    );
  }

  if (deps.chainServices && deps.chainServices.size > 0) {
    const chainServices = deps.chainServices;
    void app.register(
      gasPriceController({
        gasPriceService: new GasPriceService({
          getGasPrice: async (chainId) => {
            const chain = chainServices.get(chainId);
            if (!chain) throw new Error(`no chain services for chainId=${chainId}`);
            return chain.publicClient.getGasPrice();
          },
        }),
        configuredChainIds: [...chainServices.keys()],
        logger: deps.logger,
      }),
    );
    const tipReaders = new Map<number, ViemTipChainReader>();
    void app.register(
      tipSuggestionController({
        service: new TipSuggestionService((chainId) => {
          const chain = chainServices.get(chainId);
          if (!chain) return null;
          let reader = tipReaders.get(chainId);
          if (!reader) tipReaders.set(chainId, (reader = new ViemTipChainReader(chain.publicClient)));
          return reader;
        }),
        configuredChainIds: [...chainServices.keys()],
        logger: deps.logger,
      }),
    );
  }

  if (deps.openSeaResolver && deps.chainServices) {
    void app.register(resolveController({ openSeaResolver: deps.openSeaResolver, chainServices: deps.chainServices }));
  }

  if (deps.openSeaResolver && deps.chainServices) {
    const chainServices = deps.chainServices;
    void app.register(
      collectionResolveController({
        collectionResolverService: new CollectionResolverService({
          openSeaResolver: deps.openSeaResolver,
          chainServices,
          fetchDropInfo: deps.fetchOpenSeaDropInfo ?? (() => Promise.resolve(null)),
        }),
        collectionImageService: new CollectionImageService(chainServices),
        collectionSupplyService: new CollectionSupplyService(chainServices),
        chainServices,
        fetchDropInfo: deps.fetchOpenSeaDropInfo ?? (() => Promise.resolve(null)),
        ...(deps.fetchOpenSeaDropInfoReading ? { fetchDropInfoReading: deps.fetchOpenSeaDropInfoReading } : {}),
        logger: deps.logger,
      }),
    );
    void app.register(
      nativePriceController({
        nativePriceService: new NativePriceService(createCoinGeckoNativePriceReader((url, init) => fetch(url, init), undefined, deps.coinGeckoApiKey)),
        configuredChainIds: [...chainServices.keys()],
        logger: deps.logger,
      }),
    );
  }

  if (deps.mintEligibilityService) {
    void app.register(mintEligibilityController({ mintEligibilityService: deps.mintEligibilityService, resolveOwnerId }));
  }

  if (deps.stepUpStore) {
    void app.register(
      stepUpController({
        store: deps.stepUpStore,
        expectedToken: deps.authToken ?? '',
        resolveOwnerId,
        ...(deps.userAccountService ? { userAccountService: deps.userAccountService } : {}),
        ...(deps.walletSignIn ? { siwe: deps.walletSignIn.siwe } : {}),
      }),
    );
  }

  if (deps.mintLog) {
    void app.register(mintHistoryController({ repository: deps.mintLog, resolveOwnerId }));
  }

  if (deps.platformStats && deps.userAccountService) {
    const users = deps.userAccountService;
    void app.register(
      adminOverviewController({
        stats: deps.platformStats,
        findUser: (id) => users.getUserSummary(id),
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
        ...(deps.adminViewLimiter ? { limiter: deps.adminViewLimiter } : {}),
        ...(deps.sessions && deps.stepUpStore
          ? {
              members: {
                stepUp: deps.stepUpStore,
                sessions: deps.sessions,
                setStatus: (id: string, status: 'ACTIVE' | 'SUSPENDED') => users.setStatus(id, status),
                ...(deps.emergencyStopGuard ? { emergencyStop: deps.emergencyStopGuard } : {}),
              },
            }
          : {}),
      }),
    );
  }

  if (deps.walletSignIn && deps.sessions && deps.userAccountService) {
    void app.register(
      walletAuthController({
        siwe: deps.walletSignIn.siwe,
        codes: deps.walletSignIn.codes,
        identity: deps.walletSignIn.identity,
        sessions: deps.sessions,
        sessionCookie: deps.walletSignIn.sessionCookie,
        userAccountService: deps.userAccountService,
        limiter: deps.walletSignIn.limiter,
        ...(deps.terms ? { terms: deps.terms } : {}),
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
      }),
    );
  }

  if (deps.stepUpStore && deps.vaultSettingsService && deps.nftLedgerService) {
    void app.register(
      vaultController({
        vaultSettingsService: deps.vaultSettingsService,
        nftLedgerService: deps.nftLedgerService,
        stepUpStore: deps.stepUpStore,
        resolveOwnerId,
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
      }),
    );
  }

  if (deps.stepUpStore && deps.walletKeyExportService) {
    void app.register(
      keyExportController({
        walletKeyExportService: deps.walletKeyExportService,
        stepUpStore: deps.stepUpStore,
        resolveOwnerId,
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
      }),
    );
  }

  if (deps.dropsFeedService) {
    void app.register(homeController({ dropsFeedService: deps.dropsFeedService, logger: deps.logger }));
  }

  if (deps.terms) {
    void app.register(termsController({ terms: deps.terms, ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}) }));
  }

  if (deps.waitlist) {
    const users = deps.userAccountService;
    const signIn = deps.walletSignIn;
    const mail = deps.inviteEmail;
    const invites =
      signIn && mail
        ? {
            createCode: async (input: { label: string; createdById: string; expiresInDays: number }) => {
              const { code, record } = await signIn.codes.create({ ...input, boundAddress: null });
              return { code, id: record.id, expiresAt: record.expiresAt! };
            },
            revokeCode: (id: string) => signIn.identity.revokeAccessCode(id, new Date()),
            mailer: mail.mailer,
            appUrl: (typeof signIn.appOrigin === 'string' ? signIn.appOrigin : signIn.appOrigin[0])!,
            siteUrl: mail.siteUrl,
            xUrl: mail.xUrl,
          }
        : undefined;
    void app.register(
      waitlistController({
        service: deps.waitlist.service,
        limiter: deps.waitlist.limiter,
        ...(users ? { findUser: (id: string) => users.getUserSummary(id) } : {}),
        ...(invites ? { invites } : {}),
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
      }),
    );
  }

  if (deps.signedMint) {
    void app.register(
      signedMintController({
        ...deps.signedMint,
        resolveOwnerId,
        ...(deps.userRepository ? { userRepository: deps.userRepository } : {}),
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
      }),
    );
  }

  if (deps.emergencyStopGuard && deps.userRepository) {
    void app.register(
      emergencyStopController({
        emergencyStopGuard: deps.emergencyStopGuard,
        userRepository: deps.userRepository,
        resolveOwnerId,
        ...(deps.auditLogService ? { auditLogService: deps.auditLogService } : {}),
      }),
    );
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_error',
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }

    // A wallet that does not exist or belongs to someone else: a plain 404, and the two read the same
    // on purpose.
    if (error instanceof WalletNotFoundError) {
      return reply.code(404).send({ error: 'wallet_not_found', message: 'That wallet was not found.' });
    }

    // A wallet whose key cannot be decrypted with the current KMS key can never be recovered: say so
    // plainly instead of a generic 500.
    if (error instanceof DecryptionIntegrityError) {
      return reply.code(422).send({
        error: 'wallet_key_unavailable',
        walletId: error.scope.walletId,
        message:
          "This wallet's private key can't be decrypted and is permanently unusable for signing. " +
          'Pick a different wallet.',
      });
    }

    if (error instanceof KmsOperationError) {
      return reply.code(502).send({
        error: 'kms_operation_failed',
        message: 'The key management provider rejected the request. Try again shortly.',
      });
    }

    // Fastify's own refusals of a bad request carry their 4xx status.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send(
        status === 413 ? { error: 'payload_too_large', message: 'That request is too large.' } : { error: 'bad_request', message: 'That request could not be read.' },
      );
    }

    deps.logger.error('unhandled request error', {
      path: request.url,
      method: request.method,
      message: error instanceof Error ? error.message : String(error),
    });
    return reply.code(500).send({ error: 'internal_server_error' });
  });

  return app;
}
