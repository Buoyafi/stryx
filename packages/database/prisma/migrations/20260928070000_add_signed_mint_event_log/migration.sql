-- Signed-mint event log (Milestone 4, signed path): one row per run, one per wallet per run.
-- The app role ("stryx_app") gets SELECT, INSERT and UPDATE (the runner fills timings in as
-- they happen) but never DELETE: a run's record should outlive anything the app does. The
-- REVOKE is real because "stryx_app" does not own these tables (see provision_app_role).

-- CreateTable
CREATE TABLE "signed_mint_runs" (
    "jobId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contract" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "stageUuid" TEXT NOT NULL,
    "stageLabel" TEXT NOT NULL,
    "t0" TIMESTAMP(3) NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "simulate" BOOLEAN NOT NULL,
    "rehearsal" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "clockSkewed" BOOLEAN,
    "clockSummary" TEXT,
    "notes" TEXT,
    "warmupAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signed_mint_runs_pkey" PRIMARY KEY ("jobId")
);

-- CreateTable
CREATE TABLE "signed_mint_attempts" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "detail" TEXT,
    "txHash" TEXT,
    "nonce" INTEGER,
    "blockNumber" TEXT,
    "gasUsed" TEXT,
    "effectiveGasPriceWei" TEXT,
    "valueWei" TEXT,
    "calldataMs" INTEGER,
    "simulatedMs" INTEGER,
    "simulateDurationMs" INTEGER,
    "signedMs" INTEGER,
    "broadcastMs" INTEGER,
    "confirmedMs" INTEGER,
    "notActiveCount" INTEGER NOT NULL DEFAULT 0,
    "rateLimitedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signed_mint_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signed_mint_runs_ownerId_createdAt_idx" ON "signed_mint_runs"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "signed_mint_attempts_jobId_walletId_key" ON "signed_mint_attempts"("jobId", "walletId");

-- CreateIndex
CREATE INDEX "signed_mint_attempts_ownerId_createdAt_idx" ON "signed_mint_attempts"("ownerId", "createdAt");

-- The default privileges from provision_app_role granted full CRUD; narrow it.
REVOKE DELETE ON "signed_mint_runs", "signed_mint_attempts" FROM "stryx_app";
