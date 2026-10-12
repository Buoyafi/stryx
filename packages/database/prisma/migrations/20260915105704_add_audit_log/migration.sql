-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorType" "AuditActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "walletId" TEXT,
    "targetUserId" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_actorUserId_createdAt_idx" ON "audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_walletId_createdAt_idx" ON "audit_log"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_action_createdAt_idx" ON "audit_log"("action", "createdAt");

-- ADR-002 §3.10: "the database role the API uses for normal operation is
-- granted INSERT but not UPDATE or DELETE on AuditLog" — so an audit row
-- survives even a fully compromised application process, the same
-- independence principle as ADR-001 §3.3's KMS logs. INSERT and SELECT stay
-- granted (the app still needs to write new rows and could read its own
-- trail later); only UPDATE/DELETE are revoked.
--
-- The role running this migration, whatever it is called (it was written as "stryx",
-- the local name, and failed on any database whose owner has another name). A table
-- owner is not bound by this REVOKE anyway: the real limit is the next migration,
-- which gives the runtime role "stryx_app" only SELECT and INSERT here.
DO $$
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE ON "audit_log" FROM %I', current_user);
END
$$;
