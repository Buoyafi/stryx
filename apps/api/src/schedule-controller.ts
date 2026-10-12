import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserId } from '@stryx/wallet-service';
import type { UserRepository } from '@stryx/user-service';
import type { MintScheduler, ScheduledMintJob } from './mint-scheduler.js';
import type { AutoScheduleService } from './auto-schedule.service.js';
import { PriorityFeeGweiField, resolvePriorityFee } from './priority-fee.js';
import { adminCaller } from './admin-guard.js';

const AddressField = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const BaseMint = {
  walletId: z.string().min(1),
  nftContract: AddressField,
  chainId: z.number().int().positive(),
  quantity: z.number().int().positive().max(50),
  priorityFeeGwei: PriorityFeeGweiField,
  /** The most to pay per token, in wei: the mint is refused if the price is above it when it fires. */
  maxPriceWei: z.string().regex(/^\d+$/).optional(),
};

const AutoScheduleInputSchema = z.object({ ...BaseMint });

const UpdateJobInputSchema = z.object({
  quantity: z.number().int().positive().max(50).optional(),
  executeAt: z.union([z.string().datetime(), z.number().int().positive()]).optional(),
});

// mintParams over JSON: bigint fields as numeric strings (same as the mint endpoint).
const MintParamsJson = z.object({
  mintPrice: z.string().regex(/^\d+$/),
  maxTotalMintableByWallet: z.number().int().nonnegative(),
  startTime: z.number().int().nonnegative(),
  endTime: z.number().int().nonnegative(),
  dropStageIndex: z.number().int().nonnegative(),
  maxTokenSupplyForStage: z.string().regex(/^\d+$/),
  feeBps: z.number().int().nonnegative(),
  restrictFeeRecipients: z.boolean(),
});

const ScheduleInputSchema = z.intersection(
  z.object({
    /** ISO 8601 datetime, or unix-ms number, when to execute. */
    executeAt: z.union([z.string().datetime(), z.number().int().positive()]),
    /** The caller's own id for the job. Letters, digits, - and _ (the queue refuses ":" and all-digit ids). */
    jobId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .refine((id) => !/^\d+$/.test(id), 'jobId cannot be all digits')
      .optional(),
  }),
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('public'), ...BaseMint }),
    z.object({ kind: z.literal('allowlist-stored'), ...BaseMint, allowListId: z.string().min(1) }),
    z.object({ kind: z.literal('allowlist-opensea'), ...BaseMint, slug: z.string().min(1) }),
    z.object({ kind: z.literal('allowlist-direct'), ...BaseMint, mintParams: MintParamsJson, proof: z.array(z.string().regex(/^0x[a-fA-F0-9]{64}$/)) }),
  ]),
);

function toExecuteAtMs(executeAt: string | number): number {
  return typeof executeAt === 'number' ? executeAt : new Date(executeAt).getTime();
}

function toJob(input: z.infer<typeof ScheduleInputSchema>, ownerId: UserId, priorityFeeWei: string | undefined): ScheduledMintJob {
  const base = {
    ownerId,
    walletId: input.walletId,
    nftContract: input.nftContract as `0x${string}`,
    chainId: input.chainId,
    quantity: input.quantity,
    ...(priorityFeeWei ? { priorityFeeWei } : {}),
    ...(input.maxPriceWei !== undefined ? { maxPriceWei: input.maxPriceWei } : {}),
  };
  switch (input.kind) {
    case 'public':
      return { kind: 'public', request: base };
    case 'allowlist-stored':
      return { kind: 'allowlist-stored', request: { ...base, proofSource: 'stored', allowListId: input.allowListId } };
    case 'allowlist-opensea':
      return { kind: 'allowlist-opensea', request: { ...base, proofSource: 'opensea', slug: input.slug } };
    case 'allowlist-direct':
      return {
        kind: 'allowlist-direct',
        request: { ...base, proofSource: 'direct', proof: input.proof as `0x${string}`[], mintParams: input.mintParams },
      };
  }
}

export interface ScheduleControllerDeps {
  mintScheduler: MintScheduler;
  autoScheduleService: AutoScheduleService;
  /** Resolves the caller's owner id (ADR-002 §3.3/§3.6): see wallet.controller.ts's dep of the same name. */
  resolveOwnerId: (request: FastifyRequest) => UserId;
  /** Used to check the ADMIN role, for the platform-wide list and for cancelling another account's job. */
  userRepository?: UserRepository;
}

/** True only for a caller whose stored role is ADMIN. */
async function isCallerAdmin(deps: ScheduleControllerDeps, request: FastifyRequest): Promise<boolean> {
  const users = deps.userRepository;
  if (!users) return false;
  return (await adminCaller(request, (id) => users.findById(id))) !== null;
}

/** `?mine=1` (any value): the caller's own jobs only, even for an admin. */
export function wantsOwnOnly(request: FastifyRequest): boolean {
  return (request.query as { mine?: unknown } | undefined)?.mine !== undefined;
}

/** Schedule a mint to fire at a future time, and cancel a scheduled mint. */
export const scheduleController: (deps: ScheduleControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerScheduleRoutes(app: FastifyInstance) {
    // What is scheduled, running or recently finished. Each caller sees only their own jobs; an admin
    // sees all.
    app.get('/schedules/mints', async (request, reply) => {
      const ownerId = deps.resolveOwnerId(request);
      const admin = !wantsOwnOnly(request) && (await isCallerAdmin(deps, request));
      const jobs = await deps.mintScheduler.list(admin ? { all: true } : { ownerId });
      return reply.send({ jobs });
    });

    app.post('/schedules/mints', async (request, reply) => {
      const input = ScheduleInputSchema.parse(request.body);
      const executeAtMs = toExecuteAtMs(input.executeAt);

      if (Number.isNaN(executeAtMs)) {
        return reply.code(400).send({ error: 'invalid_execute_at' });
      }
      const fee = resolvePriorityFee(input.chainId, input.priorityFeeGwei);
      if (!fee.ok) return reply.code(400).send({ error: 'invalid_priority_fee', message: fee.message });

      const job = toJob(input, deps.resolveOwnerId(request), fee.priorityFeeWei);
      // An id already in use would schedule nothing while looking like it had.
      if (input.jobId && (await deps.mintScheduler.exists(input.jobId))) {
        return reply.code(409).send({ error: 'job_id_taken', message: 'That job id is already in use.' });
      }
      if (await deps.mintScheduler.hasPendingTwin(job, executeAtMs)) {
        return reply.code(409).send({ error: 'already_scheduled', message: 'This wallet already has this mint scheduled.' });
      }
      const jobId = await deps.mintScheduler.schedule({
        job,
        executeAt: executeAtMs,
        ...(input.jobId ? { jobId: input.jobId } : {}),
      });

      return reply.code(201).send({ jobId, executeAt: new Date(executeAtMs).toISOString() });
    });

    // No executeAt supplied: the drop's on-chain start time is read and the mint scheduled for it.
    app.post('/schedules/mints/auto', async (request, reply) => {
      const input = AutoScheduleInputSchema.parse(request.body);
      const fee = resolvePriorityFee(input.chainId, input.priorityFeeGwei);
      if (!fee.ok) return reply.code(400).send({ error: 'invalid_priority_fee', message: fee.message });

      const result = await deps.autoScheduleService.autoSchedulePublicMint({
        kind: 'public',
        request: {
          ownerId: deps.resolveOwnerId(request),
          walletId: input.walletId,
          nftContract: input.nftContract as `0x${string}`,
          chainId: input.chainId,
          quantity: input.quantity,
          ...(fee.priorityFeeWei ? { priorityFeeWei: fee.priorityFeeWei } : {}),
          ...(input.maxPriceWei !== undefined ? { maxPriceWei: input.maxPriceWei } : {}),
        },
      });

      if (!result.scheduled) {
        // chain_unavailable is a passing RPC failure, not a conflict: 503 so the caller knows retrying
        // may help.
        const status = result.reason === 'chain_unavailable' ? 503 : 409;
        return reply.code(status).send({ error: 'cannot_auto_schedule', reason: result.reason });
      }

      return reply.code(201).send({
        jobId: result.jobId,
        startTime: result.startTimeUnix ? new Date(result.startTimeUnix * 1000).toISOString() : undefined,
      });
    });

    // Edits a pending job's quantity or time without cancelling it.
    app.patch('/schedules/mints/:jobId', async (request, reply) => {
      const { jobId } = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const input = UpdateJobInputSchema.parse(request.body);
      if (input.quantity === undefined && input.executeAt === undefined) {
        return reply.code(400).send({ error: 'nothing_to_update' });
      }
      const result = await deps.mintScheduler.updateJob(jobId, deps.resolveOwnerId(request), {
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.executeAt !== undefined ? { executeAt: toExecuteAtMs(input.executeAt) } : {}),
      });
      if (!result.ok && result.reason === 'not_found') return reply.code(404).send({ error: 'schedule_not_found', jobId });
      if (!result.ok) return reply.code(409).send({ error: 'schedule_not_editable', jobId });
      return reply.code(200).send({ updated: true, jobId });
    });

    // A missing job and someone else's job get the same 404, so job ids cannot be probed.
    app.delete('/schedules/mints/:jobId', async (request, reply) => {
      const { jobId } = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const ownerId = deps.resolveOwnerId(request);
      const admin = await isCallerAdmin(deps, request);
      const cancelled = await deps.mintScheduler.cancel(jobId, ownerId, admin);
      if (cancelled === 'not_found') return reply.code(404).send({ error: 'schedule_not_found', jobId });
      if (cancelled === 'running') return reply.code(409).send({ error: 'schedule_running', message: 'This mint is running now and can no longer be cancelled.', jobId });
      return reply.code(200).send({ cancelled: true, jobId });
    });
  };
