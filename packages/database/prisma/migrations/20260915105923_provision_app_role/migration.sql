-- ADR-002 §3.10: the previous migration's `REVOKE UPDATE, DELETE ON
-- "audit_log" FROM "stryx"` has NO effect — verified live. Postgres table
-- OWNERS bypass ACL checks entirely, and "stryx" (the role `prisma migrate`
-- runs as) owns every table it created, "audit_log" included. Genuine
-- enforcement needs a role that does NOT own the table: this migration
-- creates "stryx_app", a non-owning runtime role, and grants it exactly
-- what the running application needs — full CRUD on the app's normal
-- tables, but only SELECT + INSERT on "audit_log". Never UPDATE/DELETE
-- there, so an audit row survives even a fully compromised app process.
--
-- apps/api connects as this role at RUNTIME via RUNTIME_DATABASE_URL
-- (packages/config); `prisma migrate`/`prisma studio`/etc keep using
-- DATABASE_URL ("stryx", the owning role) as before — this migration
-- itself still runs as "stryx".
--
-- DEV-ONLY PASSWORD, same convention as docker-compose.yml's
-- POSTGRES_PASSWORD=stryx_dev_only for the "stryx" role itself: fine for a
-- disposable local Postgres container, NOT a real credential. A real
-- deployment must set this role's password via its own secrets management
-- (e.g. `ALTER ROLE stryx_app WITH PASSWORD '<from a secrets manager>'`)
-- and put the resulting connection string in RUNTIME_DATABASE_URL — never
-- commit a real password into a migration file.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stryx_app') THEN
    CREATE ROLE "stryx_app" WITH LOGIN PASSWORD 'stryx_app_dev_only';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO "stryx_app";

-- Full CRUD on every table except audit_log.
GRANT SELECT, INSERT, UPDATE, DELETE ON "users", "wallets", "wallet_key_rotation_events" TO "stryx_app";

-- audit_log: INSERT + SELECT only. This is the actual enforced property.
GRANT SELECT, INSERT ON "audit_log" TO "stryx_app";

-- So a table added by a FUTURE migration (created by "stryx", the owning
-- role) automatically grants stryx_app full CRUD without a manual GRANT
-- being added to every subsequent migration — this does NOT retroactively
-- change audit_log's already-narrower grant above, and any future
-- audit-style table would need its own explicit narrower GRANT the same
-- way audit_log has here.
-- No FOR ROLE: it then means the role running this migration, whatever it is called.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "stryx_app";
