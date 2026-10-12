-- How many requests each wallet made to OpenSea's mint endpoint in a signed-mint run.
ALTER TABLE "signed_mint_attempts" ADD COLUMN "requestCount" INTEGER NOT NULL DEFAULT 0;
