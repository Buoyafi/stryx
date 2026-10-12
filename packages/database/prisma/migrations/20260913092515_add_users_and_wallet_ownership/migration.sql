/*
  ADR-002 §3.2/§3.11: adds multi-user ownership. `wallets.userId` must end up
  NOT NULL with no unowned rows, so this migration is ordered as:
    1. create `users` and the reserved operator row
    2. add `wallets.userId` NULLABLE
    3. backfill every existing wallet to the reserved operator
    4. only then tighten to NOT NULL + FK + index

  The reserved operator id below (`00000000-0000-0000-0000-000000000001`) is
  a fixed, well-known sentinel — it MUST match RESERVED_OPERATOR_USER_ID in
  apps/api/src/reserved-users.ts. Do not change one without the other.
*/

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- Seed the reserved operator user (ADR-002 §3.11). passwordHash is a
-- deliberately-invalid sentinel — this account never logs in via
-- email/password, only via the legacy API_AUTH_TOKEN bearer token, which
-- auth.ts maps onto this id. No argon2 verify call will ever match it.
INSERT INTO "users" ("id", "email", "passwordHash", "role", "status", "updatedAt")
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'operator@stryx.local',
  'disabled:operator-account-authenticates-via-bearer-token-see-adr-002-3.11',
  'ADMIN',
  'ACTIVE',
  CURRENT_TIMESTAMP
);

-- AlterTable: add nullable first so the backfill below has something to set.
ALTER TABLE "wallets" ADD COLUMN "userId" TEXT;

-- Backfill: every wallet that predates multi-user belongs to the operator.
UPDATE "wallets" SET "userId" = '00000000-0000-0000-0000-000000000001' WHERE "userId" IS NULL;

-- AlterTable: now safe to enforce NOT NULL.
ALTER TABLE "wallets" ALTER COLUMN "userId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "wallets_userId_status_idx" ON "wallets"("userId", "status");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
