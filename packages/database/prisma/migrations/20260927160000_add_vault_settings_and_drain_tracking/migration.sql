-- MintedNft gets an ownerId (denormalized, no FK, same reasoning as the rest of this
-- table) so vault-settings lookups can filter by owner without joining through wallets,
-- plus drainError/drainFailedAt to surface a failed auto-drain attempt. Existing rows are
-- backfilled from wallets.userId before the column is made required.
ALTER TABLE "minted_nfts" ADD COLUMN "ownerId" TEXT;

UPDATE "minted_nfts" m
SET "ownerId" = w."userId"
FROM "wallets" w
WHERE w."id" = m."walletId";

ALTER TABLE "minted_nfts" ALTER COLUMN "ownerId" SET NOT NULL;

ALTER TABLE "minted_nfts" ADD COLUMN "drainError" TEXT;
ALTER TABLE "minted_nfts" ADD COLUMN "drainFailedAt" TIMESTAMP(3);

CREATE INDEX "minted_nfts_ownerId_chainId_contract_idx" ON "minted_nfts"("ownerId", "chainId", "contract");

-- CreateTable
CREATE TABLE "vault_settings" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contract" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "vaultAddress" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vault_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vault_settings_ownerId_chainId_contract_key" ON "vault_settings"("ownerId", "chainId", "contract");
