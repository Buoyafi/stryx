-- Optional profile handles. Nullable columns on an existing table: no new grants needed
-- (stryx_app already has table-level SELECT, INSERT, UPDATE on "users").
ALTER TABLE "users" ADD COLUMN "discordHandle" TEXT;
ALTER TABLE "users" ADD COLUMN "xHandle" TEXT;
