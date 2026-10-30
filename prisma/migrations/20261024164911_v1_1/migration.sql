/*
  Warnings:

  - A unique constraint covering the columns `[reference]` on the table `ledger_batches` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('CUSTOMER', 'SYSTEM');

-- AlterEnum
ALTER TYPE "ledger_batch_kind" ADD VALUE 'OPENING_FUNDING';

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "label" VARCHAR(80),
ALTER COLUMN "currency" SET DEFAULT 'USD';

-- AlterTable
ALTER TABLE "ledger_batches" ADD COLUMN     "reference" VARCHAR(128),
ALTER COLUMN "transfer_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN     "general_ledger_account_id" UUID,
ALTER COLUMN "account_id" DROP NOT NULL,
ALTER COLUMN "bucket" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'CUSTOMER',
ALTER COLUMN "date_of_birth" DROP NOT NULL;

-- CreateTable
CREATE TABLE "general_ledger_accounts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,

    CONSTRAINT "general_ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "general_ledger_accounts_code_key" ON "general_ledger_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_batches_reference_key" ON "ledger_batches"("reference");

-- CreateIndex
CREATE INDEX "ledger_entries_general_ledger_account_id_created_at_idx" ON "ledger_entries"("general_ledger_account_id", "created_at");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_general_ledger_account_id_fkey" FOREIGN KEY ("general_ledger_account_id") REFERENCES "general_ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
