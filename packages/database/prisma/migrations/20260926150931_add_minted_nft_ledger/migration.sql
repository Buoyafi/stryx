-- CreateTable
CREATE TABLE "minted_nfts" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contract" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "standard" TEXT NOT NULL,
    "amount" TEXT NOT NULL DEFAULT '1',
    "mintedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transferredAt" TIMESTAMP(3),
    "transferredTo" TEXT,

    CONSTRAINT "minted_nfts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "minted_nfts_walletId_chainId_contract_idx" ON "minted_nfts"("walletId", "chainId", "contract");
