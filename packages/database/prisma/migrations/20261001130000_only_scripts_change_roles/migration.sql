-- ADR-003 §4.10: an account's role is changed only by the operator scripts (operator:grant /
-- operator:revoke, run with the migration role), never by the running app. Then a compromised app, or
-- an SQL bug, cannot promote any account to ADMIN.
--
-- 1. UPDATE: the app role ("stryx_app") loses table-level UPDATE on "users" and gets it back only on the
--    columns the app legitimately changes. Not "role", "email" or "passwordHash".
REVOKE UPDATE ON "users" FROM "stryx_app";
GRANT UPDATE ("displayName", "discordHandle", "xHandle", "status", "dailySpendCapWei", "spendCapEnabled", "updatedAt") ON "users" TO "stryx_app";

-- 2. INSERT: the app creates accounts (sign-up), and Prisma sends "role" in that INSERT, so a column
--    grant cannot keep it out. A trigger refuses any account the app role creates as anything but USER,
--    and (belt and braces with 1) any role change the app role makes.
CREATE OR REPLACE FUNCTION users_guard_role() RETURNS trigger AS $$
BEGIN
  IF current_user = 'stryx_app' THEN
    IF TG_OP = 'INSERT' AND NEW."role" <> 'USER' THEN
      RAISE EXCEPTION 'users: the app cannot create an account with role %', NEW."role" USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."role" IS DISTINCT FROM OLD."role" THEN
      RAISE EXCEPTION 'users: the app cannot change a role' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_guard_role
  BEFORE INSERT OR UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_guard_role();
