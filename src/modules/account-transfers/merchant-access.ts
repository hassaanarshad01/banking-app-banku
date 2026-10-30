import type { Prisma } from "../../../generated/prisma/client.js";

type AccountAccess = {
  ownerId: string;
  kind: string;
  merchantId: string | null;
};

export type MerchantOperation = "INTERNAL_TRANSFER" | "PARTNER_PAYOUT";

export async function lockActiveMerchant(
  tx: Prisma.TransactionClient,
  merchantId: string,
) {
  const [merchant] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM merchants
    WHERE id = ${merchantId}::uuid AND status = 'ACTIVE'
    FOR SHARE
  `;
  return Boolean(merchant);
}

export async function canOperateAccount(
  tx: Prisma.TransactionClient,
  userId: string,
  account: AccountAccess,
  operation: MerchantOperation = "INTERNAL_TRANSFER",
) {
  if (account.kind === "CUSTOMER") return account.ownerId === userId;
  if (account.kind !== "MERCHANT" || !account.merchantId) return false;
  if (!(await lockActiveMerchant(tx, account.merchantId))) return false;

  const membership = await tx.merchantMember.findUnique({
    where: { userId_merchantId: { userId, merchantId: account.merchantId } },
    select: { isActive: true, role: true },
  });
  if (!membership?.isActive) return false;
  if (operation === "PARTNER_PAYOUT") {
    return membership.role === "OWNER" || membership.role === "ADMIN";
  }
  return true;
}
