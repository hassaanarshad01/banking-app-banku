CREATE INDEX "merchant_credit_account_status_created_idx"
  ON "merchant_credit_projections"("merchant_account_id", "status", "created_at", "id");
