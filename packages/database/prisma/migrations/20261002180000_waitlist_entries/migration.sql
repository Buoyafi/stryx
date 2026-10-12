-- The landing page waitlist. Emails are personal data: the table is private to the API.
-- "stryx_app" can read, add and delete rows (delete is how a "remove me" request is honoured) and
-- change only the status, note and invite date. "stryx_analytics" is not granted anything here.

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'INVITED');

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "note" TEXT,
    "invitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "waitlist_entries_email_length" CHECK (char_length("email") BETWEEN 3 AND 254),
    CONSTRAINT "waitlist_entries_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500)
);

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entries_emailLower_key" ON "waitlist_entries"("emailLower");

-- CreateIndex
CREATE INDEX "waitlist_entries_status_createdAt_idx" ON "waitlist_entries"("status", "createdAt");

-- Privileges.
REVOKE ALL ON "waitlist_entries" FROM "stryx_app";
GRANT SELECT, INSERT, DELETE ON "waitlist_entries" TO "stryx_app";
GRANT UPDATE ("status", "note", "invitedAt") ON "waitlist_entries" TO "stryx_app";
