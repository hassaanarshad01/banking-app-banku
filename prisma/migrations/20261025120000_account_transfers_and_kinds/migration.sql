-- Give accounts a business kind so transfers can distinguish customers,
-- merchants, and system-owned accounts.
CREATE TYPE "account_kind" AS ENUM ('CUSTOMER', 'MERCHANT', 'SYSTEM');

ALTER TABLE "accounts"
  ADD COLUMN "kind" "account_kind" NOT NULL DEFAULT 'CUSTOMER';

UPDATE "accounts" AS account
SET "kind" = 'SYSTEM'
FROM "users" AS owner
WHERE account."owner_id" = owner."id"
  AND owner."role" = 'SYSTEM';

-- Preserve existing transfer records and relationships while adopting the
-- account-transfer domain name.
ALTER TYPE "transfer_status" RENAME TO "account_transfer_status";
ALTER TABLE "transfers" RENAME TO "account_transfers";
ALTER TABLE "transfer_events" RENAME TO "account_transfer_events";
ALTER TABLE "idempotency_keys" RENAME COLUMN "transfer_id" TO "account_transfer_id";
ALTER TABLE "ledger_batches" RENAME COLUMN "transfer_id" TO "account_transfer_id";
ALTER TABLE "account_transfer_events" RENAME COLUMN "transfer_id" TO "account_transfer_id";

CREATE TYPE "account_transfer_type" AS ENUM (
  'CUSTOMER_TO_CUSTOMER',
  'CUSTOMER_TO_MERCHANT',
  'MERCHANT_TO_CUSTOMER',
  'MERCHANT_TO_MERCHANT',
  'CUSTOMER_TO_SYSTEM',
  'SYSTEM_TO_CUSTOMER',
  'MERCHANT_TO_SYSTEM',
  'SYSTEM_TO_MERCHANT',
  'SYSTEM_TO_SYSTEM'
);

ALTER TABLE "account_transfers"
  ADD COLUMN "transfer_type" "account_transfer_type";

UPDATE "account_transfers" AS transfer
SET "transfer_type" = (source."kind"::text || '_TO_' || destination."kind"::text)::"account_transfer_type"
FROM "accounts" AS source, "accounts" AS destination
WHERE transfer."source_account_id" = source."id"
  AND transfer."destination_account_id" = destination."id";

ALTER TABLE "account_transfers"
  ALTER COLUMN "transfer_type" SET NOT NULL;

-- Rename constraints and indexes with the renamed tables and columns.
ALTER TABLE "account_transfers" RENAME CONSTRAINT "transfers_pkey" TO "account_transfers_pkey";
ALTER TABLE "account_transfers" RENAME CONSTRAINT "transfers_initiator_id_fkey" TO "account_transfers_initiator_id_fkey";
ALTER TABLE "account_transfers" RENAME CONSTRAINT "transfers_source_account_id_fkey" TO "account_transfers_source_account_id_fkey";
ALTER TABLE "account_transfers" RENAME CONSTRAINT "transfers_destination_account_id_fkey" TO "account_transfers_destination_account_id_fkey";
ALTER TABLE "account_transfer_events" RENAME CONSTRAINT "transfer_events_pkey" TO "account_transfer_events_pkey";
ALTER TABLE "account_transfer_events" RENAME CONSTRAINT "transfer_events_transfer_id_fkey" TO "account_transfer_events_account_transfer_id_fkey";
ALTER TABLE "idempotency_keys" RENAME CONSTRAINT "idempotency_keys_transfer_id_fkey" TO "idempotency_keys_account_transfer_id_fkey";
ALTER TABLE "ledger_batches" RENAME CONSTRAINT "ledger_batches_transfer_id_fkey" TO "ledger_batches_account_transfer_id_fkey";

ALTER INDEX "transfers_initiator_id_created_at_idx" RENAME TO "account_transfers_initiator_id_created_at_idx";
ALTER INDEX "transfers_source_account_id_created_at_idx" RENAME TO "account_transfers_source_account_id_created_at_idx";
ALTER INDEX "transfers_destination_account_id_created_at_idx" RENAME TO "account_transfers_destination_account_id_created_at_idx";
ALTER INDEX "transfers_status_created_at_idx" RENAME TO "account_transfers_status_created_at_idx";
ALTER INDEX "idempotency_keys_transfer_id_key" RENAME TO "idempotency_keys_account_transfer_id_key";
ALTER INDEX "ledger_batches_transfer_id_kind_key" RENAME TO "ledger_batches_account_transfer_id_kind_key";
ALTER INDEX "transfer_events_transfer_id_created_at_idx" RENAME TO "account_transfer_events_account_transfer_id_created_at_idx";
CREATE INDEX "account_transfers_transfer_type_created_at_idx" ON "account_transfers"("transfer_type", "created_at");
