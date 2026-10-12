/*
  Adds `wallets.origin` (GENERATED | IMPORTED) — how Stryx came to hold the
  key, independent of `tier`. For a GENERATED wallet Stryx holds the ONLY
  copy of the key; for an IMPORTED one the user presumably still holds the
  original.

  `origin` must end up NOT NULL with NO default, so a future insert path that
  forgets to set it fails loudly instead of silently labelling an imported
  wallet GENERATED. Prisma can't add a required column to a populated table by
  itself, so the ordering here is:
    1. add the column with a TEMPORARY default, so existing rows are backfilled
    2. correct the backfill where the audit log proves a wallet was imported
    3. drop the default
*/

-- CreateEnum
CREATE TYPE "WalletOrigin" AS ENUM ('GENERATED', 'IMPORTED');

-- AlterTable: temporary default, purely so existing rows get a value.
-- Every wallet that predates this migration is assumed GENERATED, except as
-- corrected in step 2 — wallets were only ever created by Stryx until
-- POST /wallets/import gained a UI.
ALTER TABLE "wallets" ADD COLUMN "origin" "WalletOrigin" NOT NULL DEFAULT 'GENERATED';

-- Backfill correction: the audit log (ADR-002 §3.10) records every
-- successful import against the wallet it created, so it — not the blanket
-- default above — is the authority for those rows. Without this, a wallet
-- imported before this migration ran would be mislabelled GENERATED, i.e.
-- "Stryx holds the only copy" for a key the user still holds elsewhere.
UPDATE "wallets"
SET "origin" = 'IMPORTED'
WHERE "id" IN (
  SELECT "walletId"
  FROM "audit_log"
  WHERE "action" = 'wallet.import'
    AND "outcome" = 'SUCCESS'
    AND "walletId" IS NOT NULL
);

-- AlterTable: no default from here on — see header.
ALTER TABLE "wallets" ALTER COLUMN "origin" DROP DEFAULT;
