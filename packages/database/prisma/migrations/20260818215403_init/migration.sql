-- CreateEnum
CREATE TYPE "WalletTier" AS ENUM ('TREASURY', 'HOT', 'MINT');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'COMPROMISED');

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "tier" "WalletTier" NOT NULL DEFAULT 'HOT',
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "encryptedPrivateKey" TEXT NOT NULL,
    "wrappedDek" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "kmsKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_key_rotation_events" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "kmsKeyId" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "wallet_key_rotation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_address_key" ON "wallets"("address");

-- CreateIndex
CREATE INDEX "wallets_tier_status_idx" ON "wallets"("tier", "status");

-- CreateIndex
CREATE INDEX "wallet_key_rotation_events_walletId_idx" ON "wallet_key_rotation_events"("walletId");

-- AddForeignKey
ALTER TABLE "wallet_key_rotation_events" ADD CONSTRAINT "wallet_key_rotation_events_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
