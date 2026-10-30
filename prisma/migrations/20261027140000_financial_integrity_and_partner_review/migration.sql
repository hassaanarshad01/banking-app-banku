ALTER TYPE "outbox_job_status" ADD VALUE 'NEEDS_REVIEW';
CREATE TYPE "partner_reconciliation_status" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "partner_webhook_status" AS ENUM ('DISPATCHED', 'COMPLETED', 'FAILED', 'UNKNOWN');

ALTER TABLE "partner_webhook_events"
  ADD COLUMN "reported_status" "partner_webhook_status" NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE "account_transfers"
  ADD CONSTRAINT "account_transfers_amount_positive_check"
  CHECK ("amount_minor" > 0);

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_positive_check"
    CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "ledger_entries_account_or_general_ledger_check"
    CHECK (
      ("account_id" IS NOT NULL AND "general_ledger_account_id" IS NULL AND "bucket" IS NOT NULL)
      OR
      ("account_id" IS NULL AND "general_ledger_account_id" IS NOT NULL AND "bucket" IS NULL)
    );

CREATE TABLE "partner_reconciliation_cases" (
  "id" UUID NOT NULL,
  "account_transfer_id" UUID NOT NULL,
  "partner_bank" "partner_bank" NOT NULL,
  "first_status" VARCHAR(16) NOT NULL,
  "latest_status" VARCHAR(16) NOT NULL,
  "reason_code" VARCHAR(64) NOT NULL,
  "first_event_id" VARCHAR(128),
  "latest_event_id" VARCHAR(128),
  "observation_count" INTEGER NOT NULL DEFAULT 1,
  "status" "partner_reconciliation_status" NOT NULL DEFAULT 'OPEN',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "partner_reconciliation_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_reconciliation_cases_account_transfer_id_fkey"
    FOREIGN KEY ("account_transfer_id") REFERENCES "account_transfers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "partner_reconciliation_cases_observations_check"
    CHECK ("observation_count" > 0),
  CONSTRAINT "partner_reconciliation_cases_status_values_check"
    CHECK ("first_status" IN ('COMPLETED', 'FAILED', 'DISPATCHED', 'NOT_FOUND', 'LOOKUP_ERROR')
      AND "latest_status" IN ('COMPLETED', 'FAILED', 'DISPATCHED', 'NOT_FOUND', 'LOOKUP_ERROR')),
  CONSTRAINT "partner_reconciliation_cases_resolution_check"
    CHECK (("status" = 'OPEN' AND "resolved_at" IS NULL) OR ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "partner_reconciliation_cases_account_transfer_id_key"
  ON "partner_reconciliation_cases"("account_transfer_id");
CREATE INDEX "partner_reconciliation_cases_status_created_at_idx"
  ON "partner_reconciliation_cases"("status", "created_at");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "account_transfers" WHERE "amount_minor" <= 0) THEN
    RAISE EXCEPTION 'Cannot enforce positive transfer amounts: existing non-positive transfers found';
  END IF;
  IF EXISTS (SELECT 1 FROM "ledger_entries" WHERE "amount_minor" <= 0) THEN
    RAISE EXCEPTION 'Cannot enforce positive ledger amounts: existing non-positive entries found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ledger_entries"
    WHERE NOT (
      ("account_id" IS NOT NULL AND "general_ledger_account_id" IS NULL AND "bucket" IS NOT NULL)
      OR
      ("account_id" IS NULL AND "general_ledger_account_id" IS NOT NULL AND "bucket" IS NULL)
    )
  ) THEN
    RAISE EXCEPTION 'Cannot enforce ledger entry ownership: existing entries have invalid account/ledger references';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ledger_batches" batch
    LEFT JOIN "ledger_entries" entry ON entry."batch_id" = batch."id"
    GROUP BY batch."id"
    HAVING COUNT(entry."id") < 2
      OR COALESCE(SUM(entry."amount_minor") FILTER (WHERE entry."side" = 'DEBIT'), 0)
         <> COALESCE(SUM(entry."amount_minor") FILTER (WHERE entry."side" = 'CREDIT'), 0)
  ) THEN
    RAISE EXCEPTION 'Cannot enforce balanced ledger batches: existing batches are empty or unbalanced';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ledger_entries" entry
    JOIN "ledger_batches" batch ON batch."id" = entry."batch_id"
    JOIN "accounts" account ON account."id" = entry."account_id"
    WHERE account."currency" <> batch."currency"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce ledger currency consistency: existing account entries disagree with their batch currency';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ledger_batches" batch
    JOIN "account_transfers" transfer ON transfer."id" = batch."account_transfer_id"
    WHERE transfer."currency" <> batch."currency"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce transfer currency consistency: existing batches disagree with their transfer currency';
  END IF;
END;
$$;

CREATE FUNCTION "validate_ledger_entry_currency"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  batch_currency CHAR(3);
  transfer_id UUID;
  referenced_currency CHAR(3);
BEGIN
  SELECT "currency", "account_transfer_id"
    INTO batch_currency, transfer_id
    FROM "ledger_batches"
    WHERE "id" = NEW."batch_id"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger entry references a missing batch' USING ERRCODE = '23503';
  END IF;

  IF NEW."account_id" IS NOT NULL THEN
    SELECT "currency" INTO referenced_currency
      FROM "accounts"
      WHERE "id" = NEW."account_id"
      FOR SHARE;
    IF referenced_currency IS DISTINCT FROM batch_currency THEN
      RAISE EXCEPTION 'Ledger entry account currency differs from batch currency' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF transfer_id IS NOT NULL THEN
    SELECT "currency" INTO referenced_currency
      FROM "account_transfers"
      WHERE "id" = transfer_id
      FOR SHARE;
    IF referenced_currency IS DISTINCT FROM batch_currency THEN
      RAISE EXCEPTION 'Ledger batch currency differs from transfer currency' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ledger_entries_currency_consistency"
BEFORE INSERT ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "validate_ledger_entry_currency"();

CREATE FUNCTION "assert_ledger_batch_balanced"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_batch_id UUID;
  entry_count BIGINT;
  debit_total NUMERIC;
  credit_total NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'ledger_batches' THEN
    target_batch_id := NEW."id";
  ELSE
    target_batch_id := NEW."batch_id";
  END IF;

  SELECT COUNT(*),
         COALESCE(SUM("amount_minor") FILTER (WHERE "side" = 'DEBIT'), 0),
         COALESCE(SUM("amount_minor") FILTER (WHERE "side" = 'CREDIT'), 0)
    INTO entry_count, debit_total, credit_total
    FROM "ledger_entries"
    WHERE "batch_id" = target_batch_id;

  IF entry_count < 2 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'Ledger batch % must contain at least two balanced entries', target_batch_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_batches_balanced_on_insert"
AFTER INSERT ON "ledger_batches"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_ledger_batch_balanced"();

CREATE CONSTRAINT TRIGGER "ledger_entries_keep_batch_balanced"
AFTER INSERT ON "ledger_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_ledger_batch_balanced"();

CREATE FUNCTION "reject_ledger_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Ledger records are immutable; post a correcting batch instead'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "ledger_entries_immutable"
BEFORE UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "reject_ledger_mutation"();

CREATE TRIGGER "ledger_batches_immutable"
BEFORE UPDATE OR DELETE ON "ledger_batches"
FOR EACH ROW EXECUTE FUNCTION "reject_ledger_mutation"();

CREATE TRIGGER "ledger_entries_immutable_truncate"
BEFORE TRUNCATE ON "ledger_entries"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_ledger_mutation"();

CREATE TRIGGER "ledger_batches_immutable_truncate"
BEFORE TRUNCATE ON "ledger_batches"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_ledger_mutation"();

CREATE FUNCTION "protect_account_ledger_currency"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."currency" IS DISTINCT FROM OLD."currency" AND EXISTS (
    SELECT 1
    FROM "ledger_entries" entry
    JOIN "ledger_batches" batch ON batch."id" = entry."batch_id"
    WHERE entry."account_id" = OLD."id" AND batch."currency" <> NEW."currency"
  ) THEN
    RAISE EXCEPTION 'Account currency change would invalidate existing ledger entries'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounts_preserve_ledger_currency"
BEFORE UPDATE OF "currency" ON "accounts"
FOR EACH ROW EXECUTE FUNCTION "protect_account_ledger_currency"();

CREATE FUNCTION "protect_transfer_ledger_currency"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."currency" IS DISTINCT FROM OLD."currency" AND EXISTS (
    SELECT 1 FROM "ledger_batches"
    WHERE "account_transfer_id" = OLD."id" AND "currency" <> NEW."currency"
  ) THEN
    RAISE EXCEPTION 'Transfer currency change would invalidate existing ledger batches'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "account_transfers_preserve_ledger_currency"
BEFORE UPDATE OF "currency" ON "account_transfers"
FOR EACH ROW EXECUTE FUNCTION "protect_transfer_ledger_currency"();
