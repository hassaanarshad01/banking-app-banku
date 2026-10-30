import argon2, { type HashOptions } from "argon2";
import { SignJWT } from "jose";
import { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../db/prisma.js";
import { AuthError } from "./auth.errors.js";
import { jwtAudience, jwtIssuer, jwtKey } from "./auth.config.js";

const passwordHashOptions: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB, OWASP's 19 MiB minimum baseline
  timeCost: 2,
  parallelism: 1,
};
const BANKU_KING_EMAIL = "banku_king@banku.local";
const SIGNUP_BONUS_MINOR = 10_000n;

// Do a password hash even when an email is unknown to reduce timing clues.
const dummyHashPromise = argon2.hash(
  "not-a-real-user-password",
  passwordHashOptions,
);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function signAccessToken(user: { id: string; authVersion: number }) {
  return new SignJWT({ authVersion: user.authVersion })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuer(jwtIssuer)
    .setAudience(jwtAudience)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(jwtKey);
}

type PublicAccount = {
  id: string;
  label: string | null;
  currency: string;
  availableBalance: bigint;
  lockedBalance: bigint;
  status: string;
  createdAt: Date;
  pendingCreditsMinor?: bigint;
};

type PublicMerchantAccount = {
  merchantId: string;
  merchantName: string;
  merchantHandle: string;
  merchantStatus: string;
  role: string;
  account: PublicAccount | null;
};

function publicUser(
  user: {
    id: string;
    email: string;
    fullName: string | null;
    phoneNumber: string | null;
    dateOfBirth: Date | null;
    createdAt: Date;
  },
  accounts: PublicAccount[] = [],
  merchantAccounts: PublicMerchantAccount[] = [],
) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phoneNumber: user.phoneNumber,
    dateOfBirth: user.dateOfBirth?.toISOString().slice(0, 10) ?? null,
    createdAt: user.createdAt.toISOString(),
    accounts: accounts.map((account) => ({
      id: account.id,
      label: account.label,
      currency: account.currency,
      availableBalanceMinor: account.availableBalance.toString(),
      lockedBalanceMinor: account.lockedBalance.toString(),
      status: account.status,
      createdAt: account.createdAt.toISOString(),
    })),
    merchantAccounts: merchantAccounts.map(({ account, ...merchant }) => ({
      ...merchant,
      account: account ? {
        id: account.id,
        label: account.label,
        currency: account.currency,
        availableBalanceMinor: account.availableBalance.toString(),
        pendingCreditsMinor: account.pendingCreditsMinor?.toString() ?? "0",
        lockedBalanceMinor: account.lockedBalance.toString(),
        status: account.status,
        createdAt: account.createdAt.toISOString(),
      } : null,
    })),
  };
}

async function getPublicMerchantAccounts(userId: string): Promise<PublicMerchantAccount[]> {
  const memberships = await prisma.merchantMember.findMany({
    where: { userId, isActive: true },
    select: {
      role: true,
      merchant: {
        select: {
          id: true,
          displayName: true,
          handle: true,
          status: true,
          accounts: {
            where: { currency: "USD", kind: "MERCHANT" },
            select: {
              id: true,
              label: true,
              currency: true,
              availableBalance: true,
              lockedBalance: true,
              status: true,
              createdAt: true,
            },
            take: 1,
          },
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

  return memberships.map(({ merchant, role }) => ({
    merchantId: merchant.id,
    merchantName: merchant.displayName,
    merchantHandle: merchant.handle,
    merchantStatus: merchant.status,
    role,
    account: merchant.accounts[0]
      ? { ...merchant.accounts[0], pendingCreditsMinor: pendingByAccount.get(merchant.accounts[0].id) ?? 0n }
      : null,
  }));
}

export async function signup(
  emailInput: string,
  password: string,
  dateOfBirth: string,
  fullName: string,
  phoneNumber: string,
) {
  const email = normalizeEmail(emailInput);
  const passwordHash = await argon2.hash(password, passwordHashOptions);

  try {
    return await prisma.$transaction(async (tx) => {
      const bankuKing = await tx.user.findUnique({
        where: { email: BANKU_KING_EMAIL },
        select: {
          id: true,
          role: true,
          accounts: {
            where: { currency: "USD", label: "Banku_King" },
            select: { id: true },
          },
        },
      });

      if (bankuKing?.role !== "SYSTEM" || !bankuKing.accounts[0]) {
        throw new AuthError("BONUS_UNAVAILABLE");
      }

      const user = await tx.user.create({
        data: {
          email,
          fullName: fullName.trim(),
          phoneNumber: phoneNumber.trim(),
          passwordHash,
          dateOfBirth: new Date(`${dateOfBirth}T00:00:00.000Z`),
        },
        select: {
          id: true, email: true, fullName: true, phoneNumber: true,
          dateOfBirth: true, createdAt: true, authVersion: true,
        },
      });
      const newAccount = await tx.account.create({
        data: { ownerId: user.id, currency: "USD", label: "Main USD account" },
        select: {
          id: true, label: true, currency: true, availableBalance: true,
          lockedBalance: true, status: true, createdAt: true,
        },
      });
      const sourceAccountId = bankuKing.accounts[0].id;

      // Lock both rows using the same UUID ordering as ordinary transfers.
      const lockedAccounts = await tx.$queryRaw<{
        id: string;
        ownerId: string;
        currency: string;
        availableBalance: bigint;
        status: string;
        kind: string;
      }[]>`
        SELECT id, owner_id AS "ownerId", currency,
               available_balance AS "availableBalance", status, kind
        FROM accounts
        WHERE id IN (${sourceAccountId}::uuid, ${newAccount.id}::uuid)
        ORDER BY id ASC
        FOR UPDATE
      `;
      const source = lockedAccounts.find((account) => account.id === sourceAccountId);
      const destination = lockedAccounts.find((account) => account.id === newAccount.id);

      if (
        !source || !destination || source.status !== "ACTIVE" || destination.status !== "ACTIVE" ||
        source.kind !== "SYSTEM" || destination.kind !== "CUSTOMER" ||
        source.currency !== "USD" || destination.currency !== "USD" ||
        source.availableBalance < SIGNUP_BONUS_MINOR
      ) {
        throw new AuthError("BONUS_UNAVAILABLE");
      }

      const debit = await tx.account.updateMany({
        where: { id: source.id, availableBalance: { gte: SIGNUP_BONUS_MINOR } },
        data: { availableBalance: { decrement: SIGNUP_BONUS_MINOR } },
      });
      if (debit.count !== 1) throw new AuthError("BONUS_UNAVAILABLE");

      await tx.account.update({
        where: { id: destination.id },
        data: { availableBalance: { increment: SIGNUP_BONUS_MINOR } },
      });

      const accountTransfer = await tx.accountTransfer.create({
        data: {
          initiatorId: bankuKing.id,
          sourceAccountId: source.id,
          destinationAccountId: destination.id,
          amountMinor: SIGNUP_BONUS_MINOR,
          currency: "USD",
          transferType: "SYSTEM_TO_CUSTOMER",
          status: "RECEIVED",
          events: { create: { toStatus: "RECEIVED" } },
        },
      });
      await tx.accountTransfer.update({
        where: { id: accountTransfer.id },
        data: {
          status: "VALIDATED",
          events: { create: { fromStatus: "RECEIVED", toStatus: "VALIDATED" } },
        },
      });
      await tx.ledgerBatch.create({
        data: {
          accountTransferId: accountTransfer.id,
          kind: "TRANSFER",
          currency: "USD",
          entries: {
            create: [
              { accountId: source.id, lineNumber: 1, bucket: "AVAILABLE", side: "DEBIT", amountMinor: SIGNUP_BONUS_MINOR },
              { accountId: destination.id, lineNumber: 2, bucket: "AVAILABLE", side: "CREDIT", amountMinor: SIGNUP_BONUS_MINOR },
            ],
          },
        },
      });
      await tx.accountTransfer.update({
        where: { id: accountTransfer.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          events: { create: { fromStatus: "VALIDATED", toStatus: "COMPLETED" } },
        },
      });

      return {
        user: publicUser(user, [{
          ...newAccount,
          availableBalance: SIGNUP_BONUS_MINOR,
        }]),
        accessToken: await signAccessToken(user),
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target.join(" ") : String(target ?? "");
      throw new AuthError(fields.includes("phone_number") ? "PHONE_ALREADY_REGISTERED" : "EMAIL_ALREADY_REGISTERED");
    }
    throw error;
  }
}

export async function login(emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      fullName: true,
      phoneNumber: true,
      dateOfBirth: true,
      createdAt: true,
      passwordHash: true,
      authVersion: true,
      role: true,
      accounts: {
        where: { kind: "CUSTOMER" },
        select: {
          id: true, label: true, currency: true, availableBalance: true,
          lockedBalance: true, status: true, createdAt: true,
        },
      },
    },
  });

  const hashToCheck = user?.passwordHash ?? await dummyHashPromise;
  const passwordIsValid = await argon2.verify(hashToCheck, password);

  if (!user || user.role !== "CUSTOMER" || !passwordIsValid) {
    throw new AuthError("INVALID_CREDENTIALS");
  }

  return {
    user: publicUser(user, user.accounts, await getPublicMerchantAccounts(user.id)),
    accessToken: await signAccessToken(user),
  };
}

export async function updateProfile(
  userId: string,
  input: { fullName: string; email: string; phoneNumber: string },
) {
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        fullName: input.fullName.trim(),
        email: normalizeEmail(input.email),
        phoneNumber: input.phoneNumber.trim() || null,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        phoneNumber: true,
        dateOfBirth: true,
        createdAt: true,
        role: true,
        accounts: {
          where: { kind: "CUSTOMER" },
          select: {
            id: true, label: true, currency: true, availableBalance: true,
            lockedBalance: true, status: true, createdAt: true,
          },
        },
      },
    });
    if (user.role !== "CUSTOMER") throw new AuthError("INVALID_CREDENTIALS");
    return publicUser(user, user.accounts, await getPublicMerchantAccounts(user.id));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target.join(" ") : String(target ?? "");
      throw new AuthError(fields.includes("phone_number") || fields.includes("phone")
        ? "PHONE_ALREADY_REGISTERED"
        : "EMAIL_ALREADY_REGISTERED");
    }
    throw error;
  }
}

export async function currentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      phoneNumber: true,
      dateOfBirth: true,
      createdAt: true,
      role: true,
      accounts: {
        where: { kind: "CUSTOMER" },
        select: {
          id: true, label: true, currency: true, availableBalance: true,
          lockedBalance: true, status: true, createdAt: true,
        },
      },
    },
  });
  if (!user || user.role !== "CUSTOMER") throw new AuthError("INVALID_CREDENTIALS");
  return publicUser(user, user.accounts, await getPublicMerchantAccounts(user.id));
}

export async function logoutAllSessions(userId: string) {
  // Versioning makes already-issued access tokens fail verification on the
  // next request. This also invalidates tokens from other browsers/devices.
  await prisma.user.update({
    where: { id: userId },
    data: { authVersion: { increment: 1 } },
  });
}

