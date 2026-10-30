import { createHash } from "node:crypto";
import type { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AccountTransferError } from "./account-transfer.errors.js";
import { canOperateAccount } from "./merchant-access.js";
import { applyPendingMerchantCreditsForDebit } from "./merchant-credit-projection.js";
import type { PartnerBankCode } from "./partner-bank.config.js";
import type { ExternalPayoutInput, PartnerWebhook } from "./partner-payout.schemas.js";

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const PAYOUT_OPERATION = "PARTNER_PAYOUT";

type LockedAccount = {
  id: string;
  ownerId: string;
  currency: string;
  availableBalance: bigint;
  lockedBalance: bigint;
  status: string;
  kind: string;
  merchantId: string | null;
  merchantStatus: string | null;
};

function hashPayout(input: ExternalPayoutInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.sourceAccountId,
    input.partnerBank,
    input.beneficiaryName,
    input.beneficiaryAccountNumber,
    input.amountMinor,
    input.currency,
  ])).digest("hex");
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

type PartnerObservation = "COMPLETED" | "FAILED" | "DISPATCHED" | "NOT_FOUND" | "LOOKUP_ERROR";

async function recordPartnerObservation(
  tx: Prisma.TransactionClient,
  input: {
    accountTransferId: string;
    partnerBank: PartnerBankCode;
    status: PartnerObservation;
    firstStatus?: PartnerObservation;
    reasonCode?: string;
    eventId?: string;
    resolved?: boolean;
  },
) {
  const existing = await tx.partnerReconciliationCase.findUnique({
    where: { accountTransferId: input.accountTransferId },
  });
  const conflictingOutcomes = input.reasonCode === "CONFLICTING_TERMINAL_OUTCOMES" ||
    existing?.reasonCode === "CONFLICTING_TERMINAL_OUTCOMES";
  const failureNeedsReview = input.reasonCode === "PARTNER_FAILURE_REQUIRES_REVIEW" ||
    existing?.reasonCode === "PARTNER_FAILURE_REQUIRES_REVIEW";
  const reasonCode = conflictingOutcomes
    ? "CONFLICTING_TERMINAL_OUTCOMES"
    : failureNeedsReview
      ? "PARTNER_FAILURE_REQUIRES_REVIEW"
      : input.reasonCode ?? existing?.reasonCode ?? "PARTNER_RECONCILIATION_REQUIRED";
  const status = input.resolved ? "RESOLVED" as const : "OPEN" as const;
  const resolvedAt = input.resolved ? new Date() : null;

  if (existing) {
    return tx.partnerReconciliationCase.update({
      where: { accountTransferId: input.accountTransferId },
      data: {
        latestStatus: input.status,
        latestEventId: input.eventId ?? existing.latestEventId,
        observationCount: { increment: 1 },
        reasonCode,
        status,
        resolvedAt,
      },
    });
  }

  return tx.partnerReconciliationCase.create({
    data: {
      accountTransferId: input.accountTransferId,
      partnerBank: input.partnerBank,
      firstStatus: input.firstStatus ?? input.status,
      latestStatus: input.status,
      firstEventId: input.eventId,
      latestEventId: input.eventId,
      reasonCode,
      status,
      resolvedAt,
    },
  });
}

async function placeTransferInReview(
  tx: Prisma.TransactionClient,
  transfer: { id: string; status: string; rejectionCode: string | null },
  partnerBank: PartnerBankCode,
  observation: PartnerObservation,
  reasonCode: string,
  eventId?: string,
  providerReference?: string,
  firstObservedStatus?: PartnerObservation,
) {
  await recordPartnerObservation(tx, {
    accountTransferId: transfer.id,
    partnerBank,
    status: observation,
    firstStatus: firstObservedStatus,
    reasonCode,
    eventId,
  });

  const terminal = transfer.status === "COMPLETED" || transfer.status === "FAILED";
  const fromStatus = transfer.status as "RECEIVED" | "VALIDATED" | "RESERVED" | "DISPATCHED" | "UNKNOWN" | "COMPLETED" | "FAILED" | "REJECTED";
  await tx.accountTransfer.update({
    where: { id: transfer.id },
    data: {
      ...(terminal ? {} : { status: "UNKNOWN" as const }),
      ...(providerReference ? { providerReference } : {}),
      rejectionCode: reasonCode,
      events: {
        create: {
          fromStatus,
          toStatus: terminal ? fromStatus : "UNKNOWN",
          reasonCode,
        },
      },
    },
  });
  await tx.outboxJob.updateMany({
    where: { accountTransferId: transfer.id },
    data: { status: "NEEDS_REVIEW", lockedAt: null, lastError: reasonCode },
  });
}

async function replayPayout(userId: string, key: string, requestHash: string) {
  const existing = await prisma.idempotencyKey.findUnique({
    where: { userId_operation_key: { userId, operation: PAYOUT_OPERATION, key } },
    include: { accountTransfer: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) throw new AccountTransferError("IDEMPOTENCY_KEY_REUSED");
  if (!existing.accountTransfer) throw new AccountTransferError("IDEMPOTENCY_RESULT_MISSING");
  return { accountTransfer: existing.accountTransfer, replayed: true as const };
}

export async function createPartnerPayout(
  userId: string,
  input: ExternalPayoutInput,
  idempotencyKey: string,
) {
  const amountMinor = BigInt(input.amountMinor);
  if (amountMinor <= 0n || amountMinor > MAX_POSTGRES_BIGINT) {
    throw new AccountTransferError("INVALID_AMOUNT");
  }
  if (!idempotencyKey || idempotencyKey.length > 255) {
    throw new AccountTransferError("INVALID_IDEMPOTENCY_KEY");
  }

  const requestHash = hashPayout(input);
  const replayed = await replayPayout(userId, idempotencyKey, requestHash);
  if (replayed) return replayed;

  try {
    return await prisma.$transaction(async (tx) => {
      const idempotency = await tx.idempotencyKey.create({
        data: {
          userId,
          operation: PAYOUT_OPERATION,
          key: idempotencyKey,
          requestHash,
          status: "PROCESSING",
        },
      });

      const [source] = await tx.$queryRaw<LockedAccount[]>`
        SELECT account.id, account.owner_id AS "ownerId", account.currency,
               account.available_balance AS "availableBalance",
               account.locked_balance AS "lockedBalance", account.status,
               account.kind, account.merchant_id AS "merchantId",
               merchant.status::text AS "merchantStatus"
        FROM accounts account
        LEFT JOIN merchants merchant ON merchant.id = account.merchant_id
        WHERE account.id = ${input.sourceAccountId}::uuid
        FOR UPDATE OF account
      `;
      if (!source) throw new AccountTransferError("ACCOUNT_NOT_FOUND");
      if (!(await canOperateAccount(tx, userId, source, "PARTNER_PAYOUT"))) {
        throw new AccountTransferError("SOURCE_ACCOUNT_NOT_OWNED");
      }
      if (
        source.status !== "ACTIVE" ||
        !["CUSTOMER", "MERCHANT"].includes(source.kind)
      ) {
        throw new AccountTransferError("ACCOUNT_NOT_ACTIVE");
      }
      if (source.currency !== input.currency) throw new AccountTransferError("CURRENCY_MISMATCH");
      if (source.kind === "MERCHANT") {
        source.availableBalance = await applyPendingMerchantCreditsForDebit(
          tx,
          source.id,
          source.availableBalance,
          amountMinor,
        );
      }

      const created = await tx.accountTransfer.create({
        data: {
          initiatorId: userId,
          sourceAccountId: source.id,
          amountMinor,
          currency: input.currency,
          transferType: source.kind === "MERCHANT"
            ? "MERCHANT_TO_PARTNER_BANK"
            : "CUSTOMER_TO_PARTNER_BANK",
          partnerBank: input.partnerBank,
          beneficiaryName: input.beneficiaryName,
          beneficiaryAccountNumber: input.beneficiaryAccountNumber,
          status: "RECEIVED",
          events: { create: { toStatus: "RECEIVED" } },
        },
      });

      await tx.accountTransfer.update({
        where: { id: created.id },
        data: {
          status: "VALIDATED",
          events: { create: { fromStatus: "RECEIVED", toStatus: "VALIDATED" } },
        },
      });

      if (source.availableBalance < amountMinor) {
        const rejected = await tx.accountTransfer.update({
          where: { id: created.id },
          data: {
            status: "REJECTED",
            rejectionCode: "INSUFFICIENT_FUNDS",
            events: {
              create: {
                fromStatus: "VALIDATED",
                toStatus: "REJECTED",
                reasonCode: "INSUFFICIENT_FUNDS",
              },
            },
          },
        });
        await tx.idempotencyKey.update({
          where: { id: idempotency.id },
          data: { status: "REJECTED", accountTransferId: created.id },
        });
        return { accountTransfer: rejected, replayed: false as const };
      }

      const reserved = await tx.account.updateMany({
        where: { id: source.id, availableBalance: { gte: amountMinor }, status: "ACTIVE" },
        data: {
          availableBalance: { decrement: amountMinor },
          lockedBalance: { increment: amountMinor },
        },
      });
      if (reserved.count !== 1) throw new Error("Account reservation guard failed while account was locked");

      await tx.ledgerBatch.create({
        data: {
          accountTransferId: created.id,
          kind: "RESERVE",
          currency: input.currency,
          entries: {
            create: [
              { accountId: source.id, lineNumber: 1, bucket: "AVAILABLE", side: "DEBIT", amountMinor },
              { accountId: source.id, lineNumber: 2, bucket: "LOCKED", side: "CREDIT", amountMinor },
            ],
          },
        },
      });

      const accountTransfer = await tx.accountTransfer.update({
        where: { id: created.id },
        data: {
          status: "RESERVED",
          events: { create: { fromStatus: "VALIDATED", toStatus: "RESERVED" } },
        },
      });
      await tx.outboxJob.create({ data: { accountTransferId: created.id } });
      await tx.idempotencyKey.update({
        where: { id: idempotency.id },
        data: { status: "PROCESSING", accountTransferId: created.id },
      });

      return { accountTransfer, replayed: false as const };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const concurrentResult = await replayPayout(userId, idempotencyKey, requestHash);
      if (concurrentResult) return concurrentResult;
    }
    throw error;
  }
}

export async function retryFailedPartnerPayout(userId: string, transferId: string) {
  const failedTransfer = await prisma.accountTransfer.findFirst({
    where: {
      id: transferId,
      transferType: { in: ["CUSTOMER_TO_PARTNER_BANK", "MERCHANT_TO_PARTNER_BANK"] },
      status: { in: ["FAILED", "REJECTED"] },
    },
    select: {
      id: true,
      initiatorId: true,
      sourceAccountId: true,
      sourceAccount: { select: { kind: true, merchantId: true } },
      partnerBank: true,
      beneficiaryName: true,
      beneficiaryAccountNumber: true,
      amountMinor: true,
      currency: true,
      reconciliationCase: { select: { status: true } },
    },
  });
  if (
    !failedTransfer?.partnerBank || !failedTransfer.beneficiaryName ||
    !failedTransfer.beneficiaryAccountNumber ||
    failedTransfer.reconciliationCase?.status === "OPEN"
  ) {
    throw new AccountTransferError("ACCOUNT_TRANSFER_NOT_RETRYABLE");
  }
  if (failedTransfer.initiatorId !== userId) {
    const membership = failedTransfer.sourceAccount.kind === "MERCHANT" && failedTransfer.sourceAccount.merchantId
      ? await prisma.merchantMember.findUnique({
          where: {
            userId_merchantId: {
              userId,
              merchantId: failedTransfer.sourceAccount.merchantId,
            },
          },
          select: { isActive: true, role: true },
        })
      : null;
    if (
      !membership?.isActive ||
      (membership.role !== "OWNER" && membership.role !== "ADMIN")
    ) {
      throw new AccountTransferError("ACCOUNT_TRANSFER_NOT_RETRYABLE");
    }
  }

  return createPartnerPayout(userId, {
    sourceAccountId: failedTransfer.sourceAccountId,
    partnerBank: failedTransfer.partnerBank,
    beneficiaryName: failedTransfer.beneficiaryName,
    beneficiaryAccountNumber: failedTransfer.beneficiaryAccountNumber,
    amountMinor: failedTransfer.amountMinor.toString(),
    currency: "USD",
  }, `retry:${failedTransfer.id}`);
}

export async function processPartnerWebhook(
  partnerBank: PartnerBankCode,
  event: PartnerWebhook,
  payloadHash: string,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM account_transfers
        WHERE id = ${event.bankTransferId}::uuid
        FOR UPDATE
      `;
      const accountTransfer = await tx.accountTransfer.findUnique({
        where: { id: event.bankTransferId },
      });
      if (
        !accountTransfer ||
        !["CUSTOMER_TO_PARTNER_BANK", "MERCHANT_TO_PARTNER_BANK"].includes(accountTransfer.transferType) ||
        accountTransfer.partnerBank !== partnerBank
      ) {
        throw new AccountTransferError("INVALID_WEBHOOK");
      }
      if (accountTransfer.providerReference && accountTransfer.providerReference !== event.providerReference) {
        throw new AccountTransferError("PROVIDER_REFERENCE_REUSED");
      }

      await tx.partnerWebhookEvent.create({
        data: {
          partnerBank,
          eventId: event.eventId,
          reportedStatus: event.status,
          providerReference: event.providerReference,
          payloadHash,
          accountTransferId: accountTransfer.id,
        },
      });

      const reconciliationCase = await tx.partnerReconciliationCase.findUnique({
        where: { accountTransferId: accountTransfer.id },
      });
      const terminal = accountTransfer.status === "COMPLETED" || accountTransfer.status === "FAILED";
      if (terminal) {
        if (
          (event.status === "COMPLETED" || event.status === "FAILED") &&
          event.status !== accountTransfer.status
        ) {
          await placeTransferInReview(
            tx,
            accountTransfer,
            partnerBank,
            event.status,
            "CONFLICTING_TERMINAL_OUTCOMES",
            event.eventId,
            event.providerReference,
            accountTransfer.status === "COMPLETED" ? "COMPLETED" : "FAILED",
          );
          return {
            duplicate: false,
            ignored: true,
            status: accountTransfer.status,
            reconciliationRequired: true,
          };
        }
        return {
          duplicate: false,
          ignored: true,
          status: accountTransfer.status,
          reconciliationRequired: reconciliationCase?.status === "OPEN",
        };
      }

      if (event.status === "DISPATCHED") {
        if (reconciliationCase?.status === "OPEN") {
          await recordPartnerObservation(tx, {
            accountTransferId: accountTransfer.id,
            partnerBank,
            status: "DISPATCHED",
            eventId: event.eventId,
          });
          return {
            duplicate: false,
            ignored: true,
            status: accountTransfer.status,
            reconciliationRequired: true,
          };
        }
        if (accountTransfer.status === "RESERVED" || accountTransfer.status === "UNKNOWN") {
          await tx.accountTransfer.update({
            where: { id: accountTransfer.id },
            data: {
              providerReference: event.providerReference,
              status: "DISPATCHED",
              events: {
                create: { fromStatus: accountTransfer.status, toStatus: "DISPATCHED" },
              },
            },
          });
        }
        return {
          duplicate: false,
          ignored: false,
          status: "DISPATCHED" as const,
          reconciliationRequired: false,
        };
      }

      if (!["RESERVED", "DISPATCHED", "UNKNOWN"].includes(accountTransfer.status)) {
        return {
          duplicate: false,
          ignored: true,
          status: accountTransfer.status,
          reconciliationRequired: reconciliationCase?.status === "OPEN",
        };
      }

      const previousTerminalOutcomes = new Set(
        [reconciliationCase?.firstStatus, reconciliationCase?.latestStatus]
          .filter((status): status is string => status === "COMPLETED" || status === "FAILED"),
      );
      const conflictingOutcome = reconciliationCase?.reasonCode === "CONFLICTING_TERMINAL_OUTCOMES" ||
        [...previousTerminalOutcomes].some((status) => status !== event.status);
      if (conflictingOutcome) {
        await placeTransferInReview(
          tx,
          accountTransfer,
          partnerBank,
          event.status,
          "CONFLICTING_TERMINAL_OUTCOMES",
          event.eventId,
          event.providerReference,
        );
        return {
          duplicate: false,
          ignored: true,
          status: "UNKNOWN" as const,
          reconciliationRequired: true,
        };
      }

      if (event.status === "FAILED") {
        await placeTransferInReview(
          tx,
          accountTransfer,
          partnerBank,
          event.status,
          "PARTNER_FAILURE_REQUIRES_REVIEW",
          event.eventId,
          event.providerReference,
        );
        return {
          duplicate: false,
          ignored: false,
          status: "UNKNOWN" as const,
          reconciliationRequired: true,
        };
      }

      const [source] = await tx.$queryRaw<LockedAccount[]>`
        SELECT id, owner_id AS "ownerId", currency,
               available_balance AS "availableBalance",
               locked_balance AS "lockedBalance", status, kind
        FROM accounts
        WHERE id = ${accountTransfer.sourceAccountId}::uuid
        FOR UPDATE
      `;
      if (!source || source.lockedBalance < accountTransfer.amountMinor) {
        throw new Error("Reserved funds are missing for partner payout");
      }

      const glAccount = await tx.generalLedgerAccount.upsert({
        where: { code: "PARTNER_BANK_SETTLEMENT_CLEARING" },
        update: {},
        create: {
          code: "PARTNER_BANK_SETTLEMENT_CLEARING",
          name: "Partner bank payout clearing",
        },
      });

      await tx.account.update({
        where: { id: source.id },
        data: { lockedBalance: { decrement: accountTransfer.amountMinor } },
      });

      await tx.ledgerBatch.create({
        data: {
          accountTransferId: accountTransfer.id,
          kind: "SETTLE",
          currency: accountTransfer.currency,
          entries: {
            create: [
              { accountId: source.id, lineNumber: 1, bucket: "LOCKED", side: "DEBIT", amountMinor: accountTransfer.amountMinor },
              { generalLedgerAccountId: glAccount.id, lineNumber: 2, bucket: null, side: "CREDIT", amountMinor: accountTransfer.amountMinor },
            ],
          },
        },
      });

      if (reconciliationCase?.status === "OPEN") {
        await recordPartnerObservation(tx, {
          accountTransferId: accountTransfer.id,
          partnerBank,
          status: "COMPLETED",
          eventId: event.eventId,
          resolved: true,
        });
      }
      await tx.accountTransfer.update({
        where: { id: accountTransfer.id },
        data: {
          providerReference: event.providerReference,
          status: "COMPLETED",
          completedAt: new Date(),
          rejectionCode: null,
          events: {
            create: {
              fromStatus: accountTransfer.status,
              toStatus: "COMPLETED",
            },
          },
        },
      });
      await tx.outboxJob.updateMany({
        where: { accountTransferId: accountTransfer.id },
        data: { status: "DONE", lockedAt: null, lastError: null },
      });
      await tx.idempotencyKey.updateMany({
        where: { accountTransferId: accountTransfer.id },
        data: { status: "SUCCEEDED" },
      });

      return { duplicate: false, ignored: false, status: "COMPLETED" as const, reconciliationRequired: false };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await prisma.partnerWebhookEvent.findUnique({
        where: { partnerBank_eventId: { partnerBank, eventId: event.eventId } },
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new AccountTransferError("WEBHOOK_EVENT_ID_REUSED");
        return { duplicate: true, ignored: true, status: "DUPLICATE" as const };
      }
      throw new AccountTransferError("PROVIDER_REFERENCE_REUSED");
    }
    throw error;
  }
}

export async function flagPartnerPayoutForReview(
  partnerBank: PartnerBankCode,
  transferId: string,
  reasonCode: string,
  observation: PartnerObservation = "NOT_FOUND",
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM account_transfers
      WHERE id = ${transferId}::uuid
      FOR UPDATE
    `;
    const transfer = await tx.accountTransfer.findUnique({ where: { id: transferId } });
    if (!transfer || transfer.partnerBank !== partnerBank) {
      throw new AccountTransferError("ACCOUNT_TRANSFER_NOT_FOUND");
    }
    await placeTransferInReview(tx, transfer, partnerBank, observation, reasonCode);
    return {
      status: transfer.status === "COMPLETED" || transfer.status === "FAILED" ? transfer.status : "UNKNOWN" as const,
      reconciliationRequired: true,
    };
  });
}

export async function getAccountTransferStatus(userId: string, transferId: string) {
  const accountTransfer = await prisma.accountTransfer.findFirst({
    where: { id: transferId },
    select: {
      id: true,
      initiatorId: true,
      sourceAccount: { select: { kind: true, merchantId: true } },
      destinationAccount: { select: { kind: true, merchantId: true } },
      status: true,
      transferType: true,
      partnerBank: true,
      amountMinor: true,
      currency: true,
      providerReference: true,
      rejectionCode: true,
      createdAt: true,
      completedAt: true,
      reconciliationCase: {
        select: { status: true, firstStatus: true, latestStatus: true, reasonCode: true },
      },
    },
  });
  if (!accountTransfer) throw new AccountTransferError("ACCOUNT_TRANSFER_NOT_FOUND");
  if (accountTransfer.initiatorId !== userId) {
    const merchantIds = [
      accountTransfer.sourceAccount,
      accountTransfer.destinationAccount,
    ].flatMap((account) => account?.kind === "MERCHANT" && account.merchantId ? [account.merchantId] : []);
    const membership = merchantIds.length > 0
      ? await prisma.merchantMember.findFirst({
          where: { userId, merchantId: { in: merchantIds }, isActive: true },
          select: { userId: true },
        })
      : null;
    if (!membership) throw new AccountTransferError("ACCOUNT_TRANSFER_NOT_FOUND");
  }
  const {
    initiatorId: _initiatorId,
    sourceAccount: _sourceAccount,
    destinationAccount: _destinationAccount,
    reconciliationCase,
    ...publicTransfer
  } = accountTransfer;
  return {
    ...publicTransfer,
    reconciliationRequired: reconciliationCase?.status === "OPEN",
    partnerReconciliation: reconciliationCase
      ? {
          status: reconciliationCase.status,
          firstStatus: reconciliationCase.firstStatus,
          latestStatus: reconciliationCase.latestStatus,
          reasonCode: reconciliationCase.reasonCode,
        }
      : null,
  };
}
