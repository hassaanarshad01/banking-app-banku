import { createHash } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { AccountTransferError } from "./account-transfer.errors.js";
import { canOperateAccount, lockActiveMerchant } from "./merchant-access.js";
import { applyPendingMerchantCreditsForDebit } from "./merchant-credit-projection.js";

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
// Keep the idempotency namespace stable across the endpoint/model rename.
const OPERATION = "P2P_TRANSFER";

export async function lookupAccountTransferRecipient(userId: string, value: string) {
  const recipient = value.trim();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient);
  const user = await prisma.user.findFirst({
    where: {
      id: { not: userId },
      role: "CUSTOMER",
      ...(isEmail
        ? { email: recipient.toLowerCase() }
        : { phoneNumber: recipient }),
    },
    select: {
      id: true,
      fullName: true,
      phoneNumber: true,
      email: true,
      accounts: {
        where: { currency: "USD", status: "ACTIVE", kind: "CUSTOMER" },
        select: { id: true },
        take: 1,
      },
    },
  });

  const account = user?.accounts[0];
  if (user && account) {
    return {
      kind: "CUSTOMER" as const,
      id: user.id,
      accountId: account.id,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      email: user.email,
      merchantHandle: null,
    };
  }

  const handle = recipient.replace(/^@/, "").toLowerCase();
  if (!isEmail && /[a-z]/i.test(handle)) {
    const merchant = await prisma.merchant.findFirst({
      where: {
        handle,
        status: "ACTIVE",
        accounts: { some: { currency: "USD", status: "ACTIVE", kind: "MERCHANT" } },
      },
      select: {
        id: true,
        handle: true,
        displayName: true,
        accounts: {
          where: { currency: "USD", status: "ACTIVE", kind: "MERCHANT" },
          select: { id: true },
          take: 1,
        },
      },
    });
    const merchantAccount = merchant?.accounts[0];
    if (merchant && merchantAccount) {
      return {
        kind: "MERCHANT" as const,
        id: merchant.id,
        accountId: merchantAccount.id,
        fullName: merchant.displayName,
        phoneNumber: null,
        email: null,
        merchantHandle: merchant.handle,
      };
    }
  }

  throw new AccountTransferError("RECIPIENT_NOT_FOUND");
}

async function getAccessibleAccountIds(userId: string, currency?: string) {
  const [ownedAccounts, memberships] = await Promise.all([
    prisma.account.findMany({
      where: { ownerId: userId, kind: "CUSTOMER", ...(currency ? { currency } : {}) },
      select: { id: true },
    }),
    prisma.merchantMember.findMany({
      where: { userId, isActive: true },
      select: { merchant: { select: { accounts: {
        where: currency ? { currency } : undefined,
        select: { id: true },
      } } } },
    }),
  ]);
  const accountIds = [...new Set([
    ...ownedAccounts.map(({ id }) => id),
    ...memberships.flatMap(({ merchant }) => merchant.accounts.map(({ id }) => id)),
  ])];
  return accountIds;
}

export async function listAccountTransfers(userId: string, accountId?: string) {
  const accessibleAccountIds = await getAccessibleAccountIds(userId);
  if (accountId && !accessibleAccountIds.includes(accountId)) {
    throw new AccountTransferError("ACCOUNT_TRANSFER_NOT_FOUND");
  }
  const accountIds = accountId ? [accountId] : accessibleAccountIds;
  if (accountIds.length === 0) return [];
  const ownAccountIds = new Set(accountIds);

  const transfers = await prisma.accountTransfer.findMany({
    where: {
      OR: [
        { sourceAccountId: { in: accountIds } },
        { destinationAccountId: { in: accountIds } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      sourceAccountId: true,
      destinationAccountId: true,
      amountMinor: true,
      currency: true,
      transferType: true,
      partnerBank: true,
      beneficiaryName: true,
      providerReference: true,
      status: true,
      rejectionCode: true,
      createdAt: true,
      completedAt: true,
      reconciliationCase: {
        select: { status: true, firstStatus: true, latestStatus: true, reasonCode: true },
      },
      sourceAccount: {
        select: {
          label: true,
          kind: true,
          owner: { select: { fullName: true } },
          merchant: { select: { displayName: true } },
        },
      },
      destinationAccount: {
        select: {
          label: true,
          kind: true,
          owner: { select: { fullName: true } },
          merchant: { select: { displayName: true } },
        },
      },
    },
  });

  return transfers.map((transfer) => {
    const outgoing = ownAccountIds.has(transfer.sourceAccountId);
    const incoming = Boolean(transfer.destinationAccountId && ownAccountIds.has(transfer.destinationAccountId));
    const internal = outgoing && incoming;
    const sourceLabel = transfer.sourceAccount.kind === "MERCHANT"
      ? transfer.sourceAccount.merchant?.displayName
      : transfer.sourceAccount.label || "Personal USD account";
    const destinationLabel = transfer.destinationAccount?.kind === "MERCHANT"
      ? transfer.destinationAccount.merchant?.displayName
      : transfer.destinationAccount?.label || "Personal USD account";
    const counterpartyName = transfer.partnerBank
      ? transfer.beneficiaryName
      : outgoing
        ? transfer.destinationAccount?.kind === "MERCHANT"
          ? transfer.destinationAccount.merchant?.displayName
          : transfer.destinationAccount?.owner.fullName
        : transfer.sourceAccount.kind === "MERCHANT"
          ? transfer.sourceAccount.merchant?.displayName
          : transfer.sourceAccount.owner.fullName;
    return {
      id: transfer.id,
      amountMinor: transfer.amountMinor.toString(),
      currency: transfer.currency,
      transferType: transfer.transferType,
      partnerBank: transfer.partnerBank,
      direction: internal ? "INTERNAL" as const : outgoing ? "OUTGOING" as const : "INCOMING" as const,
      accountLabel: internal ? `${sourceLabel} → ${destinationLabel}` : outgoing ? sourceLabel : destinationLabel,
      counterpartyName: internal ? null : counterpartyName,
      providerReference: transfer.providerReference,
      status: transfer.status,
      rejectionCode: transfer.rejectionCode,
      reconciliationRequired: transfer.reconciliationCase?.status === "OPEN",
      partnerReconciliation: transfer.reconciliationCase
        ? {
            status: transfer.reconciliationCase.status,
            firstStatus: transfer.reconciliationCase.firstStatus,
            latestStatus: transfer.reconciliationCase.latestStatus,
            reasonCode: transfer.reconciliationCase.reasonCode,
          }
        : null,
      createdAt: transfer.createdAt,
      completedAt: transfer.completedAt,
    };
  });
}

async function getSummaryAccountIds(userId: string, accountId?: string) {
  const accessibleAccountIds = await getAccessibleAccountIds(userId, "USD");
  if (accountId && !accessibleAccountIds.includes(accountId)) {
    throw new AccountTransferError("ACCOUNT_TRANSFER_NOT_FOUND");
  }
  return accountId ? [accountId] : accessibleAccountIds;
}

async function queryCashflow(accountIds: string[]) {
  if (accountIds.length === 0) return [];
  return prisma.$queryRaw<Array<{
    month: string;
    debitsMinor: string;
    creditsMinor: string;
  }>>`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', now() AT TIME ZONE 'UTC') - interval '5 months',
        date_trunc('month', now() AT TIME ZONE 'UTC'),
        interval '1 month'
      ) AS month_start
    ), activity AS (
      SELECT date_trunc('month', completed_at AT TIME ZONE 'UTC') AS month_start,
             SUM(CASE WHEN source_account_id = ANY(${accountIds}::uuid[]) THEN amount_minor ELSE 0 END)::text AS "debitsMinor",
             SUM(CASE WHEN destination_account_id = ANY(${accountIds}::uuid[]) THEN amount_minor ELSE 0 END)::text AS "creditsMinor"
      FROM account_transfers
      WHERE status = 'COMPLETED'
        AND completed_at >= ((date_trunc('month', now() AT TIME ZONE 'UTC') - interval '5 months') AT TIME ZONE 'UTC')
        AND completed_at < ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')
        AND (source_account_id = ANY(${accountIds}::uuid[]) OR destination_account_id = ANY(${accountIds}::uuid[]))
        AND NOT (
          source_account_id = ANY(${accountIds}::uuid[])
          AND destination_account_id = ANY(${accountIds}::uuid[])
        )
      GROUP BY 1
    )
    SELECT to_char(months.month_start, 'YYYY-MM') AS month,
           COALESCE(activity."debitsMinor", '0') AS "debitsMinor",
           COALESCE(activity."creditsMinor", '0') AS "creditsMinor"
    FROM months LEFT JOIN activity USING (month_start)
    ORDER BY months.month_start
  `;
}

async function queryDebitMix(accountIds: string[]) {
  if (accountIds.length === 0) return [];
  return prisma.$queryRaw<Array<{ category: string; amountMinor: string }>>`
    SELECT CASE
             WHEN transfer_type IN ('CUSTOMER_TO_PARTNER_BANK', 'MERCHANT_TO_PARTNER_BANK') THEN 'PARTNER_BANKS'
             WHEN transfer_type IN ('CUSTOMER_TO_MERCHANT', 'MERCHANT_TO_MERCHANT') THEN 'BUSINESSES'
             WHEN transfer_type IN ('CUSTOMER_TO_CUSTOMER', 'MERCHANT_TO_CUSTOMER') THEN 'PEOPLE'
             ELSE 'OTHER'
           END AS category,
           SUM(amount_minor)::text AS "amountMinor"
    FROM account_transfers
    WHERE status = 'COMPLETED' AND source_account_id = ANY(${accountIds}::uuid[])
      AND (destination_account_id IS NULL OR NOT (destination_account_id = ANY(${accountIds}::uuid[])))
      AND completed_at >= ((date_trunc('month', now() AT TIME ZONE 'UTC') - interval '5 months') AT TIME ZONE 'UTC')
      AND completed_at < ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')
    GROUP BY 1
  `;
}

export async function getAccountCashflow(userId: string, accountId?: string) {
  return queryCashflow(await getSummaryAccountIds(userId, accountId));
}

export async function getAccountDebitMix(userId: string, accountId?: string) {
  return queryDebitMix(await getSummaryAccountIds(userId, accountId));
}

export async function getAccountActivitySummary(userId: string, accountId?: string) {
  const accountIds = await getSummaryAccountIds(userId, accountId);
  const [months, debitMix] = await Promise.all([
    queryCashflow(accountIds),
    queryDebitMix(accountIds),
  ]);
  return { months, debitMix };
}

export type CreateAccountTransferInput = {
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: bigint;
  currency: string;
};

type LockedAccount = {
  id: string;
  ownerId: string;
  currency: string;
  availableBalance: bigint;
  status: string;
  kind: string;
  merchantId: string | null;
  merchantStatus: string | null;
};

function hashRequest(input: CreateAccountTransferInput): string {
  // Fixed-position JSON avoids ambiguous concatenations and does not include
  // the idempotency key itself. A key identifies an operation; this hashes it.
  const canonicalPayload = JSON.stringify([
    input.sourceAccountId,
    input.destinationAccountId,
    input.amountMinor.toString(),
    input.currency,
  ]);

  return createHash("sha256").update(canonicalPayload).digest("hex");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

async function replayIfPresent(
  userId: string,
  key: string,
  requestHash: string,
) {
  const existing = await prisma.idempotencyKey.findUnique({
    where: {
      userId_operation_key: {
        userId,
        operation: OPERATION,
        key,
      },
    },
    include: { accountTransfer: true },
  });

  if (!existing) return null;

  if (existing.requestHash !== requestHash) {
    throw new AccountTransferError("IDEMPOTENCY_KEY_REUSED");
  }

  // PROCESSING should never be committed: its row is written and finalized
  // inside the same transaction as the transfer.
  if (!existing.accountTransfer) {
    throw new AccountTransferError("IDEMPOTENCY_RESULT_MISSING");
  }

  return { accountTransfer: existing.accountTransfer, replayed: true as const };
}

/**
 * Moves funds between two internal accounts in one database transaction.
 * `userId` must come from verified authentication middleware, never the body.
 */
export async function createAccountTransfer(
  userId: string,
  input: CreateAccountTransferInput,
  idempotencyKey: string,
) {
  if (input.amountMinor <= 0n || input.amountMinor > MAX_POSTGRES_BIGINT) {
    throw new AccountTransferError("INVALID_AMOUNT");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new AccountTransferError("INVALID_CURRENCY");
  }
  if (idempotencyKey.length === 0 || idempotencyKey.length > 255) {
    throw new AccountTransferError("INVALID_IDEMPOTENCY_KEY");
  }
  if (input.sourceAccountId === input.destinationAccountId) {
    throw new AccountTransferError("SAME_ACCOUNT");
  }

  const requestHash = hashRequest(input);
  const replayed = await replayIfPresent(userId, idempotencyKey, requestHash);
  if (replayed) return replayed;

  try {
    return await prisma.$transaction(async (tx) => {
      // Claim the idempotency key in the same transaction as the transfer.
      // The unique constraint serializes concurrent attempts with this key.
      const idempotency = await tx.idempotencyKey.create({
        data: {
          userId,
          operation: OPERATION,
          key: idempotencyKey,
          requestHash,
          status: "PROCESSING",
        },
      });

      const destinationReference = await tx.$queryRaw<LockedAccount[]>`
        SELECT account.id, account.owner_id AS "ownerId", account.currency,
               account.available_balance AS "availableBalance", account.status,
               account.kind, account.merchant_id AS "merchantId",
               merchant.status::text AS "merchantStatus"
        FROM accounts account
        LEFT JOIN merchants merchant ON merchant.id = account.merchant_id
        WHERE account.id = ${input.destinationAccountId}::uuid
      `;
      const initialDestination = destinationReference[0];
      if (!initialDestination) {
        throw new AccountTransferError("ACCOUNT_NOT_FOUND");
      }

      let source: LockedAccount | undefined;
      let destination: LockedAccount | undefined;
      if (initialDestination.kind === "MERCHANT") {
        // Keep merchant receipt transactions off the merchant balance row.
        // The target read is unlocked; its immutable identity is checked again
        // before writing the ledger and projection event.
        [source] = await tx.$queryRaw<LockedAccount[]>`
          SELECT account.id, account.owner_id AS "ownerId", account.currency,
                 account.available_balance AS "availableBalance", account.status,
                 account.kind, account.merchant_id AS "merchantId",
                 merchant.status::text AS "merchantStatus"
          FROM accounts account
          LEFT JOIN merchants merchant ON merchant.id = account.merchant_id
          WHERE account.id = ${input.sourceAccountId}::uuid
          FOR UPDATE OF account
        `;
        [destination] = await tx.$queryRaw<LockedAccount[]>`
          SELECT account.id, account.owner_id AS "ownerId", account.currency,
                 account.available_balance AS "availableBalance", account.status,
                 account.kind, account.merchant_id AS "merchantId",
                 merchant.status::text AS "merchantStatus"
          FROM accounts account
          LEFT JOIN merchants merchant ON merchant.id = account.merchant_id
          WHERE account.id = ${input.destinationAccountId}::uuid
        `;
      } else {
        // Transfers to customer/system accounts retain deterministic locking.
        const accounts = await tx.$queryRaw<LockedAccount[]>`
          SELECT account.id, account.owner_id AS "ownerId", account.currency,
                 account.available_balance AS "availableBalance", account.status,
                 account.kind, account.merchant_id AS "merchantId",
                 merchant.status::text AS "merchantStatus"
          FROM accounts account
          LEFT JOIN merchants merchant ON merchant.id = account.merchant_id
          WHERE account.id IN (
            ${input.sourceAccountId}::uuid,
            ${input.destinationAccountId}::uuid
          )
          ORDER BY account.id ASC
          FOR UPDATE OF account
        `;
        source = accounts.find((account) => account.id === input.sourceAccountId);
        destination = accounts.find((account) => account.id === input.destinationAccountId);
      }

      if (!source || !destination) {
        throw new AccountTransferError("ACCOUNT_NOT_FOUND");
      }
      if (
        destination.kind === "MERCHANT" &&
        (!destination.merchantId || !(await lockActiveMerchant(tx, destination.merchantId)))
      ) {
        throw new AccountTransferError("ACCOUNT_NOT_ACTIVE");
      }
      if (!(await canOperateAccount(tx, userId, source))) {
        throw new AccountTransferError("SOURCE_ACCOUNT_NOT_OWNED");
      }
      if (source.status !== "ACTIVE" || destination.status !== "ACTIVE") {
        throw new AccountTransferError("ACCOUNT_NOT_ACTIVE");
      }
      if (
        source.currency !== destination.currency ||
        source.currency !== input.currency
      ) {
        throw new AccountTransferError("CURRENCY_MISMATCH");
      }
      if (source.kind === "MERCHANT") {
        source.availableBalance = await applyPendingMerchantCreditsForDebit(
          tx,
          source.id,
          source.availableBalance,
          input.amountMinor,
        );
      }

      const transferType = `${source.kind}_TO_${destination.kind}` as
        | "CUSTOMER_TO_CUSTOMER"
        | "CUSTOMER_TO_MERCHANT"
        | "MERCHANT_TO_CUSTOMER"
        | "MERCHANT_TO_MERCHANT"
        | "CUSTOMER_TO_SYSTEM"
        | "SYSTEM_TO_CUSTOMER"
        | "MERCHANT_TO_SYSTEM"
        | "SYSTEM_TO_MERCHANT"
        | "SYSTEM_TO_SYSTEM";

      // Create a transfer row before checking funds so a rejected attempt can
      // also be tied to its idempotency key and replayed consistently.
      const accountTransfer = await tx.accountTransfer.create({
        data: {
          initiatorId: userId,
          sourceAccountId: source.id,
          destinationAccountId: destination.id,
          amountMinor: input.amountMinor,
          currency: input.currency,
          transferType,
          status: "RECEIVED",
          events: { create: { toStatus: "RECEIVED" } },
        },
      });

      await tx.accountTransfer.update({
        where: { id: accountTransfer.id },
        data: {
          status: "VALIDATED",
          events: {
            create: { fromStatus: "RECEIVED", toStatus: "VALIDATED" },
          },
        },
      });

      if (source.availableBalance < input.amountMinor) {
        const rejected = await tx.accountTransfer.update({
          where: { id: accountTransfer.id },
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
          data: { status: "REJECTED", accountTransferId: accountTransfer.id },
        });

        // Return instead of throwing, so the rejection and idempotency result
        // commit. A retry with the same key returns this same transfer.
        return { accountTransfer: rejected, replayed: false as const };
      }

      const debit = await tx.account.updateMany({
        where: {
          id: source.id,
          availableBalance: { gte: input.amountMinor },
        },
        data: { availableBalance: { decrement: input.amountMinor } },
      });
      if (debit.count !== 1) {
        throw new Error("Source debit guard failed while account was locked");
      }

      if (destination.kind !== "MERCHANT") {
        const credit = await tx.account.updateMany({
          where: { id: destination.id, status: "ACTIVE" },
          data: { availableBalance: { increment: input.amountMinor } },
        });
        if (credit.count !== 1) {
          throw new Error("Destination credit guard failed while account was locked");
        }
      }

      // One batch groups the transfer's two immutable accounting entries.
      // Migration-level constraints/triggers must enforce balance and immutability.
      await tx.ledgerBatch.create({
        data: {
          accountTransferId: accountTransfer.id,
          kind: "TRANSFER",
          currency: input.currency,
          entries: {
            create: [
              {
                accountId: source.id,
                lineNumber: 1,
                bucket: "AVAILABLE",
                side: "DEBIT",
                amountMinor: input.amountMinor,
              },
              {
                accountId: destination.id,
                lineNumber: 2,
                bucket: "AVAILABLE",
                side: "CREDIT",
                amountMinor: input.amountMinor,
              },
            ],
          },
        },
      });

      if (destination.kind === "MERCHANT") {
        await tx.merchantCreditProjection.create({
          data: {
            accountTransferId: accountTransfer.id,
            merchantAccountId: destination.id,
            amountMinor: input.amountMinor,
          },
        });
      }

      const completed = await tx.accountTransfer.update({
        where: { id: accountTransfer.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          events: {
            create: { fromStatus: "VALIDATED", toStatus: "COMPLETED" },
          },
        },
      });

      await tx.idempotencyKey.update({
        where: { id: idempotency.id },
        data: { status: "SUCCEEDED", accountTransferId: accountTransfer.id },
      });

      return { accountTransfer: completed, replayed: false as const };
    });
  } catch (error) {
    // A simultaneous request may have won the unique-key race. If its row
    // exists, compare hashes and replay it; otherwise preserve the real error.
    if (isUniqueConstraintError(error)) {
      const concurrentResult = await replayIfPresent(
        userId,
        idempotencyKey,
        requestHash,
      );
      if (concurrentResult) return concurrentResult;
    }
    throw error;
  }
}
