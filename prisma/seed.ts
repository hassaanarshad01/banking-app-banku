import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { prisma } from "../src/db/prisma.js";

const BANKU_KING_EMAIL = "banku_king@banku.local";
const OPENING_REFERENCE = "BANKU_KING_INITIAL_100K_USD";
const INITIAL_BALANCE_MINOR = 10_000_000n;

try {
  await prisma.$transaction(async (tx) => {
    let bankuKing = await tx.user.findUnique({ where: { email: BANKU_KING_EMAIL } });
    if (bankuKing && bankuKing.role !== "SYSTEM") {
      throw new Error("Reserved Banku_King email belongs to a non-system user");
    }
    if (!bankuKing) {
      bankuKing = await tx.user.create({
        data: {
          email: BANKU_KING_EMAIL,
          passwordHash: await argon2.hash(randomBytes(32).toString("hex")),
          role: "SYSTEM",
        },
      });
    }

    const bankuAccount = await tx.account.upsert({
      where: { ownerId_currency: { ownerId: bankuKing.id, currency: "USD" } },
      update: { label: "Banku_King", kind: "SYSTEM" },
      create: {
        ownerId: bankuKing.id,
        currency: "USD",
        label: "Banku_King",
        kind: "SYSTEM",
      },
    });
    const promotionalFunding = await tx.generalLedgerAccount.upsert({
      where: { code: "BANKU_PROMOTIONAL_FUNDING" },
      update: {},
      create: {
        code: "BANKU_PROMOTIONAL_FUNDING",
        name: "Banku promotional funding expense",
      },
    });
    const openingBatch = await tx.ledgerBatch.findUnique({
      where: { reference: OPENING_REFERENCE },
      select: { id: true },
    });

    if (!openingBatch) {
      if (bankuAccount.availableBalance !== 0n) {
        throw new Error("Banku_King has a balance but no opening ledger batch; refusing to top it up");
      }

      await tx.account.update({
        where: { id: bankuAccount.id },
        data: { availableBalance: { increment: INITIAL_BALANCE_MINOR } },
      });
      await tx.ledgerBatch.create({
        data: {
          kind: "OPENING_FUNDING",
          currency: "USD",
          reference: OPENING_REFERENCE,
          entries: {
            create: [
              {
                accountId: bankuAccount.id,
                lineNumber: 1,
                bucket: "AVAILABLE",
                side: "CREDIT",
                amountMinor: INITIAL_BALANCE_MINOR,
              },
              {
                generalLedgerAccountId: promotionalFunding.id,
                lineNumber: 2,
                bucket: null,
                side: "DEBIT",
                amountMinor: INITIAL_BALANCE_MINOR,
              },
            ],
          },
        },
      });
    }
  });
  console.log("Banku_King USD treasury is ready.");
} finally {
  await prisma.$disconnect();
}
