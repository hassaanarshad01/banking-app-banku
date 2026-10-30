import type { Prisma } from "../../../generated/prisma/client.js";

const projectionBatchSize = 250;

type PendingMerchantCredit = {
  id: string;
  amountMinor: bigint;
};

async function applyCreditRows(
  tx: Prisma.TransactionClient,
  merchantAccountId: string,
  limit: number,
) {
  if (limit <= 0) return { count: 0, amountMinor: 0n };

  const credits = await tx.$queryRaw<PendingMerchantCredit[]>`
    SELECT id, amount_minor AS "amountMinor"
    FROM merchant_credit_projections
    WHERE merchant_account_id = ${merchantAccountId}::uuid
      AND status = 'PENDING'
    ORDER BY created_at, id
    LIMIT ${limit}
    FOR UPDATE
  `;
  if (credits.length === 0) return { count: 0, amountMinor: 0n };

  const amountMinor = credits.reduce((total, credit) => total + credit.amountMinor, 0n);
  const balanceUpdate = await tx.account.updateMany({
    where: { id: merchantAccountId, kind: "MERCHANT" },
    data: { availableBalance: { increment: amountMinor } },
  });
  if (balanceUpdate.count !== 1) throw new Error(`Merchant projection account ${merchantAccountId} is missing`);

  const projectionUpdate = await tx.merchantCreditProjection.updateMany({
    where: { id: { in: credits.map(({ id }) => id) }, status: "PENDING" },
    data: { status: "APPLIED", appliedAt: new Date() },
  });
  if (projectionUpdate.count !== credits.length) {
    throw new Error("Merchant credit projection batch changed while locked");
  }

  return { count: credits.length, amountMinor };
}

/** Caller must already hold the merchant account row lock. */
export async function applyPendingMerchantCreditsForDebit(
  tx: Prisma.TransactionClient,
  merchantAccountId: string,
  availableBalance: bigint,
  requiredAmount: bigint,
) {
  const [pending] = await tx.$queryRaw<Array<{ amountMinor: string }>>`
    SELECT COALESCE(SUM(amount_minor), 0)::text AS "amountMinor"
    FROM merchant_credit_projections
    WHERE merchant_account_id = ${merchantAccountId}::uuid
      AND status = 'PENDING'
  `;
  const pendingAmount = BigInt(pending?.amountMinor ?? "0");
  if (availableBalance + pendingAmount < requiredAmount) return availableBalance;

  let currentBalance = availableBalance;
  while (currentBalance < requiredAmount) {
    const applied = await applyCreditRows(tx, merchantAccountId, projectionBatchSize);
    if (applied.count === 0) break;
    currentBalance += applied.amountMinor;
  }
  return currentBalance;
}

/** Caller must lock the merchant account before claiming its projection rows. */
export async function applyPendingMerchantCreditBatch(
  tx: Prisma.TransactionClient,
  merchantAccountId: string,
  limit: number,
) {
  return applyCreditRows(tx, merchantAccountId, limit);
}
