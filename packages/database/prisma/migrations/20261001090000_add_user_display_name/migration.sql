-- The name a member chooses to be greeted by on Home ("Welcome back, Ade"). Optional and nullable on an
-- existing table: no new grants needed (stryx_app already has table-level SELECT, INSERT, UPDATE on "users").
ALTER TABLE "users" ADD COLUMN "displayName" TEXT;
