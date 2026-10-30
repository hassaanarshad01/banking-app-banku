import type { RequestHandler } from "express";
import { AccountTransferError } from "./account-transfer.errors.js";
import { createAccountTransferSchema, recipientLookupSchema } from "./account-transfer.schemas.js";
import { createAccountTransfer, getAccountActivitySummary, getAccountCashflow, getAccountDebitMix, listAccountTransfers, lookupAccountTransferRecipient } from "./account-transfer.service.js";
import { accountSummaryQuerySchema, accountTransferListQuerySchema } from "./account-transfer.schemas.js";
import { externalPayoutSchema } from "./partner-payout.schemas.js";
import { createPartnerPayout, getAccountTransferStatus, retryFailedPartnerPayout } from "./partner-payout.service.js";

function toResponse(transfer: {
  id: string;
  sourceAccountId: string;
  destinationAccountId: string | null;
  amountMinor: bigint;
  currency: string;
  transferType: string;
  partnerBank?: string | null;
  providerReference?: string | null;
  status: string;
  rejectionCode: string | null;
  reconciliationRequired?: boolean;
  partnerReconciliation?: {
    status: string;
    firstStatus: string;
    latestStatus: string;
    reasonCode: string;
  } | null;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: transfer.id,
    sourceAccountId: transfer.sourceAccountId,
    destinationAccountId: transfer.destinationAccountId,
    amountMinor: transfer.amountMinor.toString(),
    currency: transfer.currency,
    transferType: transfer.transferType,
    partnerBank: transfer.partnerBank ?? null,
    providerReference: transfer.providerReference ?? null,
    status: transfer.status,
    rejectionCode: transfer.rejectionCode,
    ...(transfer.reconciliationRequired === undefined ? {} : { reconciliationRequired: transfer.reconciliationRequired }),
    ...(transfer.partnerReconciliation === undefined ? {} : { partnerReconciliation: transfer.partnerReconciliation }),
    createdAt: transfer.createdAt,
    completedAt: transfer.completedAt,
  };
}

const errorStatuses: Record<string, number> = {
  INVALID_AMOUNT: 400,
  INVALID_CURRENCY: 400,
  INVALID_IDEMPOTENCY_KEY: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_RESULT_MISSING: 503,
  ACCOUNT_NOT_FOUND: 404,
  RECIPIENT_NOT_FOUND: 404,
  ACCOUNT_TRANSFER_NOT_FOUND: 404,
  ACCOUNT_TRANSFER_NOT_RETRYABLE: 409,
  INVALID_PARTNER_BANK: 400,
  INVALID_BENEFICIARY: 400,
  PROVIDER_REFERENCE_REUSED: 409,
  INVALID_WEBHOOK: 400,
  WEBHOOK_EVENT_ID_REUSED: 409,
  SOURCE_ACCOUNT_NOT_OWNED: 404,
  ACCOUNT_NOT_ACTIVE: 409,
  CURRENCY_MISMATCH: 422,
  SAME_ACCOUNT: 400,
  INSUFFICIENT_FUNDS: 409,
};

export const createPartnerPayoutController: RequestHandler = async (
  request,
  response,
  next,
) => {
  const parsed = externalPayoutSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }
  const idempotencyKey = request.get("Idempotency-Key")?.trim();
  if (!idempotencyKey) {
    response.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
    return;
  }

  try {
    const result = await createPartnerPayout(
      response.locals.authenticatedUser.id,
      parsed.data,
      idempotencyKey,
    );
    const rejected = result.accountTransfer.status === "REJECTED";
    response.status(rejected ? 409 : 202).json({
      accountTransfer: toResponse(result.accountTransfer),
      replayed: result.replayed,
    });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      response.status(errorStatuses[error.code] ?? 400).json({ error: error.code });
      return;
    }
    next(error);
  }
};

export const accountTransferStatusController: RequestHandler = async (request, response, next) => {
  const transferId = request.params.transferId;
  if (typeof transferId !== "string") {
    response.status(404).json({ error: "ACCOUNT_TRANSFER_NOT_FOUND" });
    return;
  }
  try {
    const accountTransfer = await getAccountTransferStatus(
      response.locals.authenticatedUser.id,
      transferId,
    );
    response.json({ accountTransfer: { ...accountTransfer, amountMinor: accountTransfer.amountMinor.toString() } });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      response.status(errorStatuses[error.code] ?? 400).json({ error: error.code });
      return;
    }
    next(error);
  }
};

export const accountTransferListController: RequestHandler = async (request, response, next) => {
  const parsed = accountTransferListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }
  try {
    const accountTransfers = await listAccountTransfers(
      response.locals.authenticatedUser.id,
      parsed.data.accountId,
    );
    response.json({ accountTransfers });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      response.status(errorStatuses[error.code] ?? 400).json({ error: error.code });
      return;
    }
    next(error);
  }
};

export const accountActivitySummaryController: RequestHandler = async (request, response, next) => {
  const parsed = accountSummaryQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }
  try {
    const summary = await getAccountActivitySummary(
      response.locals.authenticatedUser.id,
      parsed.data.accountId,
    );
    response.json({ summary });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      response.status(errorStatuses[error.code] ?? 400).json({ error: error.code });
      return;
    }
    next(error);
  }
};

export const accountCashflowController: RequestHandler = async (request, response, next) => {
  const parsed = accountSummaryQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }
  try {
    const months = await getAccountCashflow(response.locals.authenticatedUser.id, parsed.data.accountId);
    response.json({ months });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      response.status(errorStatuses[error.code] ?? 400).json({ error: error.code });
      return;
    }
    response.status(503).json({ error: "CASHFLOW_GRAPH_UNAVAILABLE" });
  }
};

export const accountDebitMixController: RequestHandler = async (request, response, next) => {
  const parsed = accountSummaryQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }
  try {
    const debitMix = await getAccountDebitMix(response.locals.authenticatedUser.id, parsed.data.accountId);
    response.json({ debitMix });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      response.status(errorStatuses[error.code] ?? 400).json({ error: error.code });
      return;
    }
    response.status(503).json({ error: "DEBIT_MIX_GRAPH_UNAVAILABLE" });
  }
};

export const retryPartnerPayoutController: RequestHandler = async (request, response, next) => {
  const transferId = request.params.transferId;
  if (typeof transferId !== "string") {
    response.status(404).json({ error: "ACCOUNT_TRANSFER_NOT_FOUND" });
    return;
  }
  try {
    const result = await retryFailedPartnerPayout(
      response.locals.authenticatedUser.id,
      transferId,
    );
    const rejected = result.accountTransfer.status === "REJECTED";
    response.status(rejected ? 409 : 202).json({
      accountTransfer: toResponse(result.accountTransfer),
      replayed: result.replayed,
    });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      response.status(errorStatuses[error.code] ?? 400).json({ error: error.code });
      return;
    }
    next(error);
  }
};

export const recipientLookupController: RequestHandler = async (
  request,
  response,
  next,
) => {
  const parsed = recipientLookupSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }

  try {
    const recipient = await lookupAccountTransferRecipient(
      response.locals.authenticatedUser.id,
      parsed.data.recipient,
    );
    response.json({ recipient });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      response.status(errorStatuses[error.code] ?? 400).json({ error: error.code });
      return;
    }
    next(error);
  }
};

export const createAccountTransferController: RequestHandler = async (
  request,
  response,
  next,
) => {
  const parsed = createAccountTransferSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }

  const idempotencyKey = request.get("Idempotency-Key")?.trim();
  if (!idempotencyKey) {
    response.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
    return;
  }

  try {
    const result = await createAccountTransfer(
      response.locals.authenticatedUser.id,
      {
        ...parsed.data,
        amountMinor: BigInt(parsed.data.amountMinor),
      },
      idempotencyKey,
    );

    const rejected = result.accountTransfer.status === "REJECTED";
    response.status(rejected ? 409 : result.replayed ? 200 : 201).json({
      accountTransfer: toResponse(result.accountTransfer),
      replayed: result.replayed,
    });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      response.status(errorStatuses[error.code] ?? 400).json({ error: error.code });
      return;
    }
    next(error);
  }
};
