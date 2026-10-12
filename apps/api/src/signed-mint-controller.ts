import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserId, WalletService } from '@stryx/wallet-service';
import type { UserRepository } from '@stryx/user-service';
import type { SignedMintScheduler } from './signed-mint-scheduler.js';
import type { SignedMintRepository } from './signed-mint-repository.js';
import type { SignedMintJobData } from './signed-mint-runner.js';
import type { SignedStageResolution } from './signed-mint-start-resolver.js';
import type { AuditLogService } from './audit-log-service.js';
import { PriorityFeeGweiField, resolvePriorityFee } from './priority-fee.js';
import { adminCaller } from './admin-guard.js';
import { wantsOwnOnly } from './schedule-controller.js';
import { credentialActorType } from './audit-actor.js';

/** A job must be scheduled at least this far ahead of its warm-up, so warm-up is never skipped. */
const MIN_LEAD_MS = 10_000;
/** "Mint now" on a live stage: T-0 is this far after the request. */
const FIRE_NOW_LEAD_MS = 2_000;

const Wei = z.string().regex(/^\d+$/, 'must be a decimal wei string');

const ScheduleSignedInput = z.object({
  chainId: z.number().int().positive(),
  nftContract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  slug: z.string().min(1),
  stageUuid: z.string().min(1),
  wallets: z
    .array(z.object({ walletId: z.string().min(1), quantity: z.number().int().positive().max(50) }))
    .min(1)
    .max(100)
    .refine((ws) => new Set(ws.map((w) => w.walletId)).size === ws.length, 'each wallet may appear once'),
  /** The per-token price the operator saw in the UI and accepts. A signed price above it is refused. */
  maxPriceWei: Wei,
  simulate: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  /** Optional ceiling on the job's total mint value (price x quantity, all wallets). */
  maxSpendWei: Wei.nullable().default(null),
  /** Priority fee (tip) in gwei; blank for the network's suggestion. Only where the tip orders transactions. */
  priorityFeeGwei: PriorityFeeGweiField,
  /** Dry runs only: fire at this time (ISO or unix ms) instead of the stage start, to rehearse. */
  rehearsalStartAt: z.union([z.string().datetime(), z.number().int().positive()]).optional(),
  /** The stage is already live: fire now instead of at its start. Real or dry run. */
  fireNow: z.boolean().default(false),
});

export interface SignedMintControllerDeps {
  scheduler: SignedMintScheduler;
  repository: SignedMintRepository;
  walletService: Pick<WalletService, 'getWalletSummary'>;
  resolveStage: (params: { slug: string; stageUuid: string; chainId: number; contract: `0x${string}` }) => Promise<SignedStageResolution>;
  resolveOwnerId: (request: FastifyRequest) => UserId;
  executionEnabled: boolean;
  retryIntervalMs: number;
  giveUpMs: number;
  userRepository?: UserRepository;
  auditLogService?: AuditLogService;
  now?: () => number;
}

async function isCallerAdmin(deps: SignedMintControllerDeps, request: FastifyRequest): Promise<boolean> {
  const users = deps.userRepository;
  if (!users) return false;
  return (await adminCaller(request, (id) => users.findById(id))) !== null;
}

/** Signed-mint scheduling for OpenSea's signed stages: schedule, list, cancel, and the per-wallet report with timings. */
export const signedMintController: (deps: SignedMintControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerSignedMintRoutes(app: FastifyInstance) {
    const now = deps.now ?? Date.now;

    /** Lets the dashboard show the kill switch's state before anyone tries to schedule. */
    app.get('/signed-mints/status', async () => ({
      executionEnabled: deps.executionEnabled,
      retryIntervalMs: deps.retryIntervalMs,
      giveUpMs: deps.giveUpMs,
    }));

    app.post('/signed-mints', async (request, reply) => {
      if (!deps.executionEnabled) {
        return reply.code(403).send({ error: 'signed_mint_disabled', message: 'Signed-mint execution is off (SIGNED_MINT_EXECUTION_ENABLED).' });
      }
      const input = ScheduleSignedInput.parse(request.body);
      const ownerId = deps.resolveOwnerId(request);
      const contract = input.nftContract as `0x${string}`;

      const fee = resolvePriorityFee(input.chainId, input.priorityFeeGwei);
      if (!fee.ok) return reply.code(400).send({ error: 'invalid_priority_fee', message: fee.message });

      if (input.fireNow && input.rehearsalStartAt !== undefined) {
        return reply.code(400).send({ error: 'fire_now_with_rehearsal', message: 'Choose either "mint now" or a rehearsal time, not both.' });
      }
      let rehearsalStartMs: number | null = null;
      if (input.rehearsalStartAt !== undefined) {
        if (!input.dryRun) return reply.code(400).send({ error: 'rehearsal_requires_dry_run', message: 'A custom fire time is allowed for dry runs only.' });
        rehearsalStartMs = typeof input.rehearsalStartAt === 'number' ? input.rehearsalStartAt : Date.parse(input.rehearsalStartAt);
      }

      for (const w of input.wallets) {
        try {
          await deps.walletService.getWalletSummary(ownerId, w.walletId);
        } catch {
          return reply.code(404).send({ error: 'wallet_not_found', walletId: w.walletId });
        }
      }

      const resolved = await deps.resolveStage({ slug: input.slug, stageUuid: input.stageUuid, chainId: input.chainId, contract });
      if (!resolved.ok) {
        const status = resolved.reason === 'opensea_unavailable' || resolved.reason === 'rpc_unavailable' ? 503 : 409;
        return reply.code(status).send({ error: 'cannot_schedule_signed_mint', reason: resolved.reason, message: resolved.detail });
      }
      const { timing } = resolved;

      const maxPerWallet = timing.maxPerWallet;
      const over = maxPerWallet === null ? undefined : input.wallets.find((w) => w.quantity > maxPerWallet);
      if (over) {
        return reply.code(400).send({ error: 'quantity_over_stage_limit', walletId: over.walletId, message: `This stage allows at most ${maxPerWallet} per wallet.` });
      }

      if (input.fireNow) {
        const at = now();
        if (timing.startMs > at) {
          return reply.code(409).send({ error: 'stage_not_live', message: 'This stage has not started yet: schedule it for its start instead.' });
        }
        if (timing.endMs !== null && timing.endMs <= at) {
          return reply.code(409).send({ error: 'stage_ended', message: 'This stage has already ended.' });
        }
      }

      const startMs = input.fireNow ? now() + FIRE_NOW_LEAD_MS : (rehearsalStartMs ?? timing.startMs);
      if (!input.fireNow && startMs - now() < MIN_LEAD_MS) {
        return reply.code(409).send({
          error: 'too_close_to_start',
          message: rehearsalStartMs === null ? 'The stage starts too soon (or has started) to schedule with a full warm-up.' : 'Pick a rehearsal time at least 10 seconds ahead.',
        });
      }

      const data: SignedMintJobData = {
        ownerId,
        chainId: input.chainId,
        nftContract: contract,
        slug: input.slug,
        stageUuid: input.stageUuid,
        stageLabel: timing.label,
        startMs,
        maxPriceWei: input.maxPriceWei,
        wallets: input.wallets,
        settings: {
          simulate: input.simulate,
          dryRun: input.dryRun,
          maxSpendWei: input.maxSpendWei,
          ...(fee.priorityFeeWei ? { priorityFeeWei: fee.priorityFeeWei } : {}),
          retryIntervalMs: deps.retryIntervalMs,
          giveUpMs: deps.giveUpMs,
        },
        rehearsal: rehearsalStartMs !== null,
        immediate: input.fireNow,
      };
      const jobId = await deps.scheduler.schedule(data);
      await deps.auditLogService?.record({
        actorUserId: ownerId,
        actorType: credentialActorType(request),
        action: 'mint.signed.schedule',
        targetUserId: ownerId,
        outcome: 'success',
        detail: `job ${jobId}, chain ${input.chainId}, contract ${contract}, stage ${timing.label}, ${input.wallets.length} wallet(s)${input.dryRun ? ', dry run' : ''}${input.fireNow ? ', mint now' : ''}`,
      });

      return reply.code(201).send({
        jobId,
        startAt: new Date(startMs).toISOString(),
        stageLabel: timing.label,
        stagePriceWei: timing.priceWei,
        rehearsal: data.rehearsal,
        immediate: input.fireNow,
      });
    });

    app.get('/signed-mints', async (request) => {
      const ownerId = deps.resolveOwnerId(request);
      const admin = !wantsOwnOnly(request) && (await isCallerAdmin(deps, request));
      return { jobs: await deps.scheduler.list(admin ? { all: true } : { ownerId }) };
    });

    app.delete('/signed-mints/:jobId', async (request, reply) => {
      const { jobId } = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const ownerId = deps.resolveOwnerId(request);
      const result = await deps.scheduler.cancel(jobId, ownerId, await isCallerAdmin(deps, request));
      if (result === 'not_found') return reply.code(404).send({ error: 'schedule_not_found', jobId });
      if (result === 'not_cancellable') return reply.code(409).send({ error: 'schedule_finished', jobId });
      return reply.send({ jobId, result });
    });

    /** The run and every wallet's outcome and timings: what the dashboard and the report show. */
    app.get('/signed-mints/:jobId/report', async (request, reply) => {
      const { jobId } = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const ownerId = deps.resolveOwnerId(request);
      const run = await deps.repository.getRun(jobId);
      if (!run || (run.ownerId !== ownerId && !(await isCallerAdmin(deps, request)))) {
        return reply.code(404).send({ error: 'schedule_not_found', jobId });
      }
      const attempts = await deps.repository.listAttempts(jobId);
      return { run, attempts };
    });
  };
