import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserId } from '@stryx/wallet-service';
import type { AuditLogService } from './audit-log-service.js';
import type { NftLedgerService } from './nft-ledger.service.js';
import { VaultAddressRequiredError, type VaultSettingsService } from './vault-settings.service.js';
import { requireStepUp } from './step-up-controller.js';
import type { StepUpStore } from './step-up-store.js';
import { credentialActorType } from './audit-actor.js';

const AddressField = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte address');

const VaultQuerySchema = z.object({ chainId: z.coerce.number().int().positive() });
const VaultPutInputSchema = z.object({
  chainId: z.number().int().positive(),
  enabled: z.boolean(),
  vaultAddress: AddressField.nullable(),
});

export interface VaultControllerDeps {
  vaultSettingsService: VaultSettingsService;
  nftLedgerService: NftLedgerService;
  stepUpStore: StepUpStore;
  resolveOwnerId: (request: FastifyRequest) => UserId;
  auditLogService?: AuditLogService;
}

/** One vault per chain. Reading is ordinary; changing it needs a live step-up grant. */
export const vaultController: (deps: VaultControllerDeps) => FastifyPluginAsync = (deps) =>
  async function registerVaultRoutes(app: FastifyInstance) {
    app.get('/vault-settings', async (request, reply) => {
      const { chainId } = VaultQuerySchema.parse(request.query);
      const ownerId = deps.resolveOwnerId(request);

      const [setting, lastFailure] = await Promise.all([
        deps.vaultSettingsService.get(ownerId, chainId),
        deps.nftLedgerService.findLatestDrainFailure(ownerId, chainId),
      ]);

      return reply.send({
        ...setting,
        lastDrainFailure: lastFailure
          ? { contract: lastFailure.contract, tokenId: lastFailure.tokenId, error: lastFailure.drainError, at: lastFailure.drainFailedAt }
          : null,
      });
    });

    app.put('/vault-settings', async (request, reply) => {
      const ownerId = deps.resolveOwnerId(request);
      if (!(await requireStepUp(deps.stepUpStore, ownerId, reply))) return;

      const input = VaultPutInputSchema.parse(request.body);

      try {
        const saved = await deps.vaultSettingsService.set({ ownerId, ...input });
        await deps.auditLogService?.record({
          actorUserId: ownerId,
          actorType: credentialActorType(request),
          action: 'vault.settings.update',
          outcome: 'success',
          detail: `chainId=${input.chainId} enabled=${input.enabled}`,
        });
        return reply.send({ enabled: saved.enabled, vaultAddress: saved.vaultAddress });
      } catch (err) {
        if (err instanceof VaultAddressRequiredError) {
          return reply.code(400).send({ error: 'vault_address_required', message: err.message });
        }
        throw err;
      }
    });
  };
