import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserId } from '@stryx/wallet-service';
import type { MintEventRepository, MintEventRow } from './mint-event-log.js';
import { CursorSchema, nextCursor } from './cursor.js';

const QuerySchema = z.object({
  /** Page backwards: the `nextBefore` of the previous page. */
  before: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** What a history row looks like on the wire: the owner id stays on the server. */
function view(r: MintEventRow) {
  return {
    id: r.id,
    walletId: r.walletId,
    walletAddress: r.walletAddress,
    chainId: r.chainId,
    contract: r.contractAddress,
    kind: r.kind,
    quantity: r.quantity,
    source: r.source,
    jobId: r.jobId,
    status: r.status,
    failureReason: r.failureReason,
    failureNote: r.failureNote,
    txHash: r.txHash,
    blockNumber: r.blockNumber,
    gasUsed: r.gasUsed,
    feeWei: r.feeWei,
    valueWei: r.valueWei,
    createdAt: r.createdAt.toISOString(),
    broadcastAt: r.broadcastAt?.toISOString() ?? null,
    settledAt: r.settledAt?.toISOString() ?? null,
  };
}

/** `GET /me/mints`: the signed-in account's own mint history from the mint log, newest first, a page at a time. */
export const mintHistoryController: (deps: { repository: MintEventRepository; resolveOwnerId: (request: FastifyRequest) => UserId }) => FastifyPluginAsync = (deps) =>
  async function registerMintHistoryRoutes(app: FastifyInstance) {
    app.get('/me/mints', async (request) => {
      const q = QuerySchema.parse(request.query);
      const ownerId = deps.resolveOwnerId(request);
      const rows = await deps.repository.listForOwner(ownerId, { ...(q.before ? { before: q.before } : {}), limit: q.limit });
      // The first page also says when this account's history begins, so a client knows which older
      // local records the server cannot have.
      const firstAt = q.before ? undefined : ((await deps.repository.firstCreatedAt(ownerId))?.toISOString() ?? null);
      return {
        mints: rows.map(view),
        nextBefore: nextCursor(rows, q.limit),
        ...(firstAt !== undefined ? { firstAt } : {}),
      };
    });
  };
