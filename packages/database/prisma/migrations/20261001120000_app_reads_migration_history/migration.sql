-- Lets the app check at startup that the database has every migration it was built for, instead of
-- failing later with "column does not exist" 500s. Read-only, and only migration names and times.
GRANT SELECT ON "_prisma_migrations" TO "stryx_app";
