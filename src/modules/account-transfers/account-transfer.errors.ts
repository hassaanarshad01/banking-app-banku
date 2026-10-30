export type AccountTransferErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_CURRENCY"
  | "INVALID_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_RESULT_MISSING"
  | "ACCOUNT_NOT_FOUND"
  | "RECIPIENT_NOT_FOUND"
  | "SOURCE_ACCOUNT_NOT_OWNED"
  | "ACCOUNT_NOT_ACTIVE"
  | "CURRENCY_MISMATCH"
  | "SAME_ACCOUNT"
  | "INSUFFICIENT_FUNDS"
  | "INVALID_PARTNER_BANK"
  | "INVALID_BENEFICIARY"
  | "INVALID_WEBHOOK"
  | "WEBHOOK_EVENT_ID_REUSED"
  | "PROVIDER_REFERENCE_REUSED"
  | "ACCOUNT_TRANSFER_NOT_FOUND"
  | "ACCOUNT_TRANSFER_NOT_RETRYABLE"

export class AccountTransferError extends Error {
  constructor(public readonly code: AccountTransferErrorCode) {
    super(code);
    this.name = "AccountTransferError";
  }
}
