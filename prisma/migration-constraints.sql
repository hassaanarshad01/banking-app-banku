-- Append this to the generated initial migration after Prisma creates tables.

ALTER TABLE "users"
  ADD CONSTRAINT "users_customer_requires_date_of_birth"
  CHECK ("role" <> 'CUSTOMER' OR "date_of_birth" IS NOT NULL);

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_balances_nonnegative"
  CHECK ("available_balance" >= 0 AND "locked_balance" >= 0);

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_positive_amount"
  CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "ledger_entries_exactly_one_account"
  CHECK (
    ("account_id" IS NOT NULL AND "general_ledger_account_id" IS NULL AND "bucket" IS NOT NULL)
    OR
    ("account_id" IS NULL AND "general_ledger_account_id" IS NOT NULL AND "bucket" IS NULL)
  );

CREATE FUNCTION "assert_ledger_batch_balanced"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_batch uuid;
  batch_currency char(3);
  entry_count bigint;
  debits numeric;
  credits numeric;
BEGIN
  target_batch := COALESCE(
    NULLIF(to_jsonb(NEW)->>'batch_id', '')::uuid,
    NULLIF(to_jsonb(NEW)->>'id', '')::uuid
  );

  SELECT currency INTO batch_currency
  FROM ledger_batches WHERE id = target_batch;

  SELECT COUNT(*),
         COALESCE(SUM(amount_minor) FILTER (WHERE side = 'DEBIT'), 0),
         COALESCE(SUM(amount_minor) FILTER (WHERE side = 'CREDIT'), 0)
    INTO entry_count, debits, credits
  FROM ledger_entries WHERE batch_id = target_batch;

  IF entry_count < 2 OR debits <> credits THEN
    RAISE EXCEPTION 'Ledger batch % is unbalanced', target_batch
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ledger_entries entry
    JOIN accounts account ON account.id = entry.account_id
    WHERE entry.batch_id = target_batch
      AND account.currency <> batch_currency
  ) THEN
    RAISE EXCEPTION 'Ledger batch % contains an account in a different currency', target_batch
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_batches_must_balance"
AFTER INSERT ON "ledger_batches"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_ledger_batch_balanced"();

CREATE CONSTRAINT TRIGGER "ledger_entries_must_balance_batch"
AFTER INSERT ON "ledger_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_ledger_batch_balanced"();

CREATE FUNCTION "reject_ledger_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Ledger rows are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "ledger_entries_immutable"
BEFORE UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "reject_ledger_mutation"();

CREATE TRIGGER "ledger_batches_immutable"
BEFORE UPDATE OR DELETE ON "ledger_batches"
FOR EACH ROW EXECUTE FUNCTION "reject_ledger_mutation"();
