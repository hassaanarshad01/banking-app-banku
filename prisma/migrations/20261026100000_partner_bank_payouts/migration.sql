ALTER TYPE "account_transfer_type" ADD VALUE 'CUSTOMER_TO_PARTNER_BANK';

CREATE TYPE "partner_bank" AS ENUM ('NATIONAL', 'STATE', 'HOLY');
CREATE TYPE "outbox_job_status" AS ENUM ('READY', 'PROCESSING', 'DONE', 'UNKNOWN');

ALTER TABLE "account_transfers"
  ALTER COLUMN "destination_account_id" DROP NOT NULL,
  ADD COLUMN "partner_bank" "partner_bank",
  ADD COLUMN "beneficiary_name" VARCHAR(120),
  ADD COLUMN "beneficiary_account_number" VARCHAR(64),
  ADD COLUMN "provider_reference" VARCHAR(128),
  ADD CONSTRAINT "account_transfers_destination_fields_check" CHECK (
    ("destination_account_id" IS NOT NULL AND "partner_bank" IS NULL
      AND "beneficiary_name" IS NULL AND "beneficiary_account_number" IS NULL)
    OR
    ("destination_account_id" IS NULL AND "partner_bank" IS NOT NULL
      AND "beneficiary_name" IS NOT NULL AND "beneficiary_account_number" IS NOT NULL)
  );

CREATE UNIQUE INDEX "account_transfers_provider_reference_key"
  ON "account_transfers"("provider_reference");

CREATE TABLE "outbox_jobs" (
  "id" UUID NOT NULL,
  "account_transfer_id" UUID NOT NULL,
  "status" "outbox_job_status" NOT NULL DEFAULT 'READY',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ(6),
  "last_error" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "outbox_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbox_jobs_account_transfer_id_fkey"
    FOREIGN KEY ("account_transfer_id") REFERENCES "account_transfers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "outbox_jobs_account_transfer_id_key"
  ON "outbox_jobs"("account_transfer_id");
CREATE INDEX "outbox_jobs_status_available_at_created_at_idx"
  ON "outbox_jobs"("status", "available_at", "created_at");

CREATE TABLE "partner_webhook_events" (
  "id" UUID NOT NULL,
  "partner_bank" "partner_bank" NOT NULL,
  "event_id" VARCHAR(128) NOT NULL,
  "provider_reference" VARCHAR(128) NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "account_transfer_id" UUID,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partner_webhook_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_webhook_events_account_transfer_id_fkey"
    FOREIGN KEY ("account_transfer_id") REFERENCES "account_transfers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "partner_webhook_events_partner_bank_event_id_key"
  ON "partner_webhook_events"("partner_bank", "event_id");
CREATE INDEX "partner_webhook_events_provider_reference_idx"
  ON "partner_webhook_events"("provider_reference");
