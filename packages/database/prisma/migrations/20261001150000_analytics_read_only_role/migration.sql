-- ADR-003 §4.11: the operator Overview's queries (apps/api platform-stats.ts) run as their own role,
-- "stryx_analytics", which can only READ, and only what those queries need. Then a bug in an analytics
-- query cannot change anything, and cannot read key material or password hashes, whatever it does.
--
-- DEV-ONLY PASSWORD, same convention as "stryx_app": change it on a real database
-- (ALTER ROLE stryx_analytics WITH PASSWORD '...') and put the connection string in
-- ANALYTICS_DATABASE_URL. Without that setting the API runs these queries as "stryx_app", as before.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stryx_analytics') THEN
    CREATE ROLE "stryx_analytics" WITH LOGIN PASSWORD 'stryx_analytics_dev_only';
  END IF;
END
$$;

-- Read-only even if a grant below is ever widened by mistake.
ALTER ROLE "stryx_analytics" SET default_transaction_read_only = on;

GRANT USAGE ON SCHEMA public TO "stryx_analytics";

-- The mint log and the audit log: everything in them.
GRANT SELECT ON "mint_events", "audit_log" TO "stryx_analytics";

-- Accounts: never "passwordHash" or "email".
GRANT SELECT ("id", "role", "status", "displayName", "discordHandle", "xHandle", "createdAt", "updatedAt") ON "users" TO "stryx_analytics";

-- Sign-in wallets: addresses only.
GRANT SELECT ("id", "userId", "address", "addressLower", "addedAt", "lastUsedAt") ON "sign_in_wallets" TO "stryx_analytics";

-- Bot wallets: never "encryptedPrivateKey", "wrappedDek", "iv", "authTag", "kmsKeyId" or "keyVersion".
GRANT SELECT ("id", "address", "label", "tier", "status", "origin", "userId", "createdAt", "updatedAt") ON "wallets" TO "stryx_analytics";
