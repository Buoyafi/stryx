-- The vault is per chain, not per collection. Keep the most recently updated setting
-- for each (owner, chain) and drop the contract column.
DELETE FROM "vault_settings" v
USING "vault_settings" newer
WHERE v."ownerId" = newer."ownerId"
  AND v."chainId" = newer."chainId"
  AND (v."updatedAt", v."id") < (newer."updatedAt", newer."id");

DROP INDEX "vault_settings_ownerId_chainId_contract_key";
ALTER TABLE "vault_settings" DROP COLUMN "contract";
CREATE UNIQUE INDEX "vault_settings_ownerId_chainId_key" ON "vault_settings"("ownerId", "chainId");
