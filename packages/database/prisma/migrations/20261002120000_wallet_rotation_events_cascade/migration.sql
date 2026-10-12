-- Deleting a wallet failed once its key had been rotated: its rotation events still pointed at it.
-- They now go with the wallet (the audit log keeps the record of the rotation and of the delete).
ALTER TABLE "wallet_key_rotation_events" DROP CONSTRAINT "wallet_key_rotation_events_walletId_fkey";
ALTER TABLE "wallet_key_rotation_events" ADD CONSTRAINT "wallet_key_rotation_events_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
