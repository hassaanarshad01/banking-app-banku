-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "transfer_status" AS ENUM ('RECEIVED', 'VALIDATED', 'RESERVED', 'DISPATCHED', 'UNKNOWN', 'COMPLETED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('PROCESSING', 'SUCCEEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ledger_batch_kind" AS ENUM ('TRANSFER', 'RESERVE', 'SETTLE', 'RELEASE');

-- CreateEnum
CREATE TYPE "ledger_bucket" AS ENUM ('AVAILABLE', 'LOCKED');

-- CreateEnum
CREATE TYPE "ledger_side" AS ENUM ('DEBIT', 'CREDIT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "auth_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "available_balance" BIGINT NOT NULL DEFAULT 0,
    "locked_balance" BIGINT NOT NULL DEFAULT 0,
    "status" "account_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "accounts"
ADD CONSTRAINT "accounts_balances_nonnegative"
CHECK ("available_balance" >= 0 AND "locked_balance" >= 0);

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL,
    "initiator_id" UUID NOT NULL,
    "source_account_id" UUID NOT NULL,
    "destination_account_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "transfer_status" NOT NULL DEFAULT 'RECEIVED',
    "rejection_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'PROCESSING',
    "transfer_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_batches" (
    "id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "kind" "ledger_batch_kind" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "bucket" "ledger_bucket" NOT NULL,
    "side" "ledger_side" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_events" (
    "id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "from_status" "transfer_status",
    "to_status" "transfer_status" NOT NULL,
    "reason_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "accounts_owner_id_status_idx" ON "accounts"("owner_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_owner_id_currency_key" ON "accounts"("owner_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_id_currency_key" ON "accounts"("id", "currency");

-- CreateIndex
CREATE INDEX "transfers_initiator_id_created_at_idx" ON "transfers"("initiator_id", "created_at");

-- CreateIndex
CREATE INDEX "transfers_source_account_id_created_at_idx" ON "transfers"("source_account_id", "created_at");

-- CreateIndex
CREATE INDEX "transfers_destination_account_id_created_at_idx" ON "transfers"("destination_account_id", "created_at");

-- CreateIndex
CREATE INDEX "transfers_status_created_at_idx" ON "transfers"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_transfer_id_key" ON "idempotency_keys"("transfer_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_operation_key_key" ON "idempotency_keys"("user_id", "operation", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_batches_transfer_id_kind_key" ON "ledger_batches"("transfer_id", "kind");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_created_at_idx" ON "ledger_entries"("account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_batch_id_line_number_key" ON "ledger_entries"("batch_id", "line_number");

-- CreateIndex
CREATE INDEX "transfer_events_transfer_id_created_at_idx" ON "transfer_events"("transfer_id", "created_at");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_initiator_id_fkey" FOREIGN KEY ("initiator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_source_account_id_fkey" FOREIGN KEY ("source_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_destination_account_id_fkey" FOREIGN KEY ("destination_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_batches" ADD CONSTRAINT "ledger_batches_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ledger_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_events" ADD CONSTRAINT "transfer_events_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
