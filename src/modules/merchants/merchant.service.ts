import { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import type { CreateMerchantInput } from "./merchant.schemas.js";

export class MerchantError extends Error {
  constructor(public readonly code: "MERCHANT_HANDLE_TAKEN" | "INVALID_USER") {
    super(code);
    this.name = "MerchantError";
  }
}

const merchantAccountSelect = {
  id: true,
  label: true,
  currency: true,
  availableBalance: true,
  lockedBalance: true,
  status: true,
  createdAt: true,
} as const;

function publicAccount(account: {
  id: string;
  label: string | null;
  currency: string;
  availableBalance: bigint;
  lockedBalance: bigint;
  status: string;
  createdAt: Date;
} | undefined, pendingCreditsMinor = 0n) {
  if (!account) return null;
  return {
    id: account.id,
    label: account.label,
    currency: account.currency,
    availableBalanceMinor: account.availableBalance.toString(),
    pendingCreditsMinor: pendingCreditsMinor.toString(),
    lockedBalanceMinor: account.lockedBalance.toString(),
    status: account.status,
    createdAt: account.createdAt.toISOString(),
  };
}

export async function createMerchant(userId: string, input: CreateMerchantInput) {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (!user || user.role !== "CUSTOMER") throw new MerchantError("INVALID_USER");

      const merchant = await tx.merchant.create({
        data: {
          displayName: input.displayName,
          handle: input.handle,
          createdByUserId: userId,
          members: { create: { userId, role: "OWNER" } },
          accounts: {
            create: {
              ownerId: userId,
              currency: "USD",
              kind: "MERCHANT",
              label: `${input.displayName} USD account`.slice(0, 80),
            },
          },
        },
        select: {
          id: true,
          handle: true,
          displayName: true,
          status: true,
          createdAt: true,
          members: { where: { userId }, select: { role: true } },
          accounts: { where: { currency: "USD" }, select: merchantAccountSelect },
        },
      });

      const { members, accounts, ...merchantDetails } = merchant;
      return {
        ...merchantDetails,
        createdAt: merchantDetails.createdAt.toISOString(),
        role: members[0]?.role ?? "OWNER",
        account: publicAccount(accounts[0]),
      };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new MerchantError("MERCHANT_HANDLE_TAKEN");
    }
    throw error;
  }
}

export async function listMyMerchants(userId: string) {
  const memberships = await prisma.merchantMember.findMany({
    where: { userId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      merchant: {
        select: {
          id: true,
          handle: true,
          displayName: true,
          status: true,
          createdAt: true,
          accounts: { where: { currency: "USD" }, select: merchantAccountSelect },
        },
      },
    },
  });

  const accountIds = memberships.flatMap(({ merchant }) => merchant.accounts.map(({ id }) => id));
  const pending = accountIds.length ? await prisma.merchantCreditProjection.groupBy({
    by: ["merchantAccountId"],
    where: { merchantAccountId: { in: accountIds }, status: "PENDING" },
    _sum: { amountMinor: true },
  }) : [];
  const pendingByAccount = new Map(pending.map(({ merchantAccountId, _sum }) => [merchantAccountId, _sum.amountMinor ?? 0n]));

  return memberships.map(({ merchant, role }) => {
    const { accounts, ...merchantDetails } = merchant;
    return {
      ...merchantDetails,
      createdAt: merchantDetails.createdAt.toISOString(),
      role,
      account: publicAccount(accounts[0], accounts[0] ? pendingByAccount.get(accounts[0].id) : 0n),
    };
  });
}
