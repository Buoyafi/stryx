-- Evidence of terms acceptance (docs/legal). Append-only: "stryx_app" can add and read rows and never
-- change or delete one. "stryx_analytics" is granted nothing here. No foreign key to "users" on purpose:
-- the record has to outlive whatever happens to the account.

-- CreateTable
CREATE TABLE "terms_acceptances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "privacyVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "terms_acceptances_source_known" CHECK ("source" IN ('sign_up', 're_accept')),
    CONSTRAINT "terms_acceptances_version_length" CHECK (char_length("termsVersion") <= 32 AND char_length("privacyVersion") <= 32),
    CONSTRAINT "terms_acceptances_ua_length" CHECK ("userAgent" IS NULL OR char_length("userAgent") <= 300)
);

-- CreateIndex
CREATE INDEX "terms_acceptances_userId_acceptedAt_idx" ON "terms_acceptances"("userId", "acceptedAt");

-- Privileges.
REVOKE ALL ON "terms_acceptances" FROM "stryx_app";
GRANT SELECT, INSERT ON "terms_acceptances" TO "stryx_app";
