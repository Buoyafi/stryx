-- The mint event log (ADR-003 §4.9). One row per wallet per mint attempt.
--
-- Privileges, enforced by Postgres rather than by convention: "stryx_app" (which does not own the
-- table) can SELECT and INSERT, can UPDATE only the outcome columns listed below, and can never
-- DELETE. A table-level UPDATE cannot be narrowed by a column REVOKE, so table-level UPDATE is
-- revoked and the allowed columns are granted one by one: a column added later is read-only to the
-- app until someone grants it, which fails safe. A trigger refuses illegal status changes.
--
-- Also: new tables no longer give "stryx_app" UPDATE and DELETE by default (provision_app_role set
-- full CRUD as the default, which would silently undo protections like these on the next table).
-- From here on each migration states any UPDATE/DELETE it needs.

-- CreateEnum
CREATE TYPE "MintEventStatus" AS ENUM ('SENDING', 'PENDING', 'CONFIRMED', 'REVERTED', 'DROPPED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "MintEventSource" AS ENUM ('MANUAL', 'SCHEDULED', 'API');

-- CreateEnum
CREATE TYPE "MintEventKind" AS ENUM ('PUBLIC', 'ALLOWLIST', 'SIGNED');

-- CreateTable
CREATE TABLE "mint_events" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "kind" "MintEventKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "source" "MintEventSource" NOT NULL,
    "jobId" TEXT,
    "status" "MintEventStatus" NOT NULL,
    "failureReason" TEXT,
    "failureNote" TEXT,
    "txHash" TEXT,
    "nonce" INTEGER,
    "blockNumber" BIGINT,
    "gasUsed" DECIMAL(78,0),
    "effectiveGasPriceWei" DECIMAL(78,0),
    "feeWei" DECIMAL(78,0),
    "valueWei" DECIMAL(78,0),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "broadcastAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "mint_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mint_events_ownerId_createdAt_idx" ON "mint_events"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "mint_events_status_chainId_idx" ON "mint_events"("status", "chainId");

-- CreateIndex
CREATE INDEX "mint_events_chainId_txHash_idx" ON "mint_events"("chainId", "txHash");

-- Privileges.
REVOKE ALL ON "mint_events" FROM "stryx_app";
GRANT SELECT, INSERT ON "mint_events" TO "stryx_app";
GRANT UPDATE ("status", "failureReason", "failureNote", "txHash", "nonce", "blockNumber", "gasUsed", "effectiveGasPriceWei", "feeWei", "broadcastAt", "settledAt") ON "mint_events" TO "stryx_app";

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE UPDATE, DELETE ON TABLES FROM "stryx_app";

-- Legal status changes only. Staying in the same status is allowed (filling in gas after the fact).
CREATE FUNCTION mint_events_guard_status() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF (OLD."status" = 'SENDING' AND NEW."status" IN ('PENDING', 'BLOCKED'))
     OR (OLD."status" = 'PENDING' AND NEW."status" IN ('CONFIRMED', 'REVERTED', 'DROPPED'))
     OR (OLD."status" = 'DROPPED' AND NEW."status" IN ('CONFIRMED', 'REVERTED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'mint_events: illegal status change % -> % for %', OLD."status", NEW."status", OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mint_events_status_guard
  BEFORE UPDATE OF "status" ON "mint_events"
  FOR EACH ROW EXECUTE FUNCTION mint_events_guard_status();
