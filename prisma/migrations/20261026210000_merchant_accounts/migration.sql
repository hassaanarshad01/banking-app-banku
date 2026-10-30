CREATE TYPE "merchant_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "merchant_member_role" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR');
CREATE TYPE "merchant_credit_projection_status" AS ENUM ('PENDING', 'APPLIED');

ALTER TYPE "account_transfer_type" ADD VALUE 'MERCHANT_TO_PARTNER_BANK';

CREATE TABLE "merchants" (
  "id" UUID NOT NULL,
  "handle" VARCHAR(32) NOT NULL,
  "display_name" VARCHAR(120) NOT NULL,
  "status" "merchant_status" NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "merchants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchants_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "merchants_handle_key" ON "merchants"("handle");
CREATE INDEX "merchants_created_by_user_id_created_at_idx"
  ON "merchants"("created_by_user_id", "created_at");

CREATE TABLE "merchant_members" (
  "user_id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "role" "merchant_member_role" NOT NULL DEFAULT 'OPERATOR',
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "merchant_members_pkey" PRIMARY KEY ("user_id", "merchant_id"),
  CONSTRAINT "merchant_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "merchant_members_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "merchant_members_merchant_id_is_active_idx"
  ON "merchant_members"("merchant_id", "is_active");

ALTER TABLE "accounts" ADD COLUMN "merchant_id" UUID;
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounts_merchant_kind_check" CHECK (
    ("kind" = 'MERCHANT' AND "merchant_id" IS NOT NULL)
    OR ("kind" <> 'MERCHANT' AND "merchant_id" IS NULL)
  );

DROP INDEX IF EXISTS "accounts_owner_id_currency_key";
CREATE UNIQUE INDEX "accounts_customer_owner_currency_key"
  ON "accounts"("owner_id", "currency") WHERE "kind" = 'CUSTOMER';
CREATE UNIQUE INDEX "accounts_merchant_currency_key"
  ON "accounts"("merchant_id", "currency") WHERE "merchant_id" IS NOT NULL;
CREATE INDEX "accounts_merchant_id_status_idx" ON "accounts"("merchant_id", "status");

CREATE TABLE "merchant_credit_projections" (
  "id" UUID NOT NULL,
  "account_transfer_id" UUID NOT NULL,
  "merchant_account_id" UUID NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "status" "merchant_credit_projection_status" NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_at" TIMESTAMPTZ(6),
  CONSTRAINT "merchant_credit_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "merchant_credit_projections_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "merchant_credit_projections_applied_at_check" CHECK (
    ("status" = 'PENDING' AND "applied_at" IS NULL)
    OR ("status" = 'APPLIED' AND "applied_at" IS NOT NULL)
  ),
  CONSTRAINT "merchant_credit_projections_account_transfer_id_fkey"
    FOREIGN KEY ("account_transfer_id") REFERENCES "account_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "merchant_credit_projections_merchant_account_id_fkey"
    FOREIGN KEY ("merchant_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "merchant_credit_projections_account_transfer_id_key"
  ON "merchant_credit_projections"("account_transfer_id");
CREATE INDEX "merchant_credit_projections_status_created_at_merchant_account_id_idx"
  ON "merchant_credit_projections"("status", "created_at", "merchant_account_id");

CREATE FUNCTION "assert_merchant_credit_account"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "accounts"
    WHERE "id" = NEW."merchant_account_id" AND "kind" = 'MERCHANT'
  ) THEN
    RAISE EXCEPTION 'Merchant credit projection must reference a merchant account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "merchant_credit_projection_requires_merchant_account"
BEFORE INSERT OR UPDATE OF "merchant_account_id" ON "merchant_credit_projections"
FOR EACH ROW EXECUTE FUNCTION "assert_merchant_credit_account"();
