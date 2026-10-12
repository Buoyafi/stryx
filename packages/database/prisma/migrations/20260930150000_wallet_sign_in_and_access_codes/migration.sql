-- Wallet sign-in and invite codes (ADR-003 §4.1, §4.4; CONTEXT.md "Invite code first").
-- users.email and users.passwordHash become nullable: an account created by wallet sign-in has
-- neither (ADR-003 expand step; the old password columns are dropped in a later contract step).
-- "stryx_app" gets its default privileges on the new tables (provision_app_role), minus DELETE on
-- access_codes: a used or revoked code stays on record. sign_in_wallets keeps DELETE so a wallet
-- can be unlinked later (ADR-003 §4.4).

-- CreateEnum
CREATE TYPE "SignInWalletKind" AS ENUM ('EOA', 'CONTRACT');

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "sign_in_wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "addressLower" TEXT NOT NULL,
    "kind" "SignInWalletKind" NOT NULL DEFAULT 'EOA',
    "chainId" INTEGER,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "sign_in_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "label" TEXT,
    "createdById" TEXT NOT NULL,
    "boundAddressLower" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sign_in_wallets_addressLower_key" ON "sign_in_wallets"("addressLower");

-- CreateIndex
CREATE INDEX "sign_in_wallets_userId_idx" ON "sign_in_wallets"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "access_codes_codeHash_key" ON "access_codes"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "access_codes_redeemedById_key" ON "access_codes"("redeemedById");

-- CreateIndex
CREATE INDEX "access_codes_createdAt_idx" ON "access_codes"("createdAt");

-- AddForeignKey
ALTER TABLE "sign_in_wallets" ADD CONSTRAINT "sign_in_wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_codes" ADD CONSTRAINT "access_codes_redeemedById_fkey" FOREIGN KEY ("redeemedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The app never deletes an invite code. The REVOKE is real because "stryx_app" does not own the table.
REVOKE DELETE ON "access_codes" FROM "stryx_app";
