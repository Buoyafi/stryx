-- AlterTable
ALTER TABLE "users" ADD COLUMN     "dailySpendCapWei" TEXT,
ADD COLUMN     "spendCapEnabled" BOOLEAN NOT NULL DEFAULT true;

-- ADR-002 §3.7: the operator's own account is configured with no cap,
-- without special-casing "the operator" anywhere in code — this row is
-- that mechanism. Every other (future) user keeps the default (capped,
-- using the platform default until they're given their own).
UPDATE "users" SET "spendCapEnabled" = false WHERE "id" = '00000000-0000-0000-0000-000000000001';
