import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../db/prisma.js";
import { flagPartnerPayoutForReview, processPartnerWebhook } from "../modules/account-transfers/partner-payout.service.js";
import {
  getPartnerBankConfig,
  partnerBankSlug,
  type PartnerBankCode,
} from "../modules/account-transfers/partner-bank.config.js";

const webhookUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}/api/webhooks/partner-banks`;
const requestTimeoutMs = 8_000;
const retryDelayMs = 5_000;

type PayoutResponse = {
  payout: {
    providerReference: string;
    status: "DISPATCHED" | "COMPLETED" | "FAILED";
    createdAt: string;
  };
};

async function claimNextJob() {
  return prisma.$transaction(async (tx) => {
    const [candidate] = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status::text AS status
      FROM outbox_jobs
      WHERE (
        status IN ('READY', 'UNKNOWN') AND available_at <= now()
      ) OR (
        status = 'PROCESSING' AND locked_at < now() - interval '60 seconds'
      )
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!candidate) return null;

    await tx.$executeRaw`
      UPDATE outbox_jobs
      SET status = 'PROCESSING', attempts = attempts + 1,
          locked_at = now(), updated_at = now()
      WHERE id = ${candidate.id}::uuid
    `;
    const job = await tx.outboxJob.findUnique({
      where: { id: candidate.id },
      include: { accountTransfer: true },
    });
    return job ? { job, previousStatus: candidate.status } : null;
  });
}

async function lookupPayout(bank: PartnerBankCode, transferId: string): Promise<PayoutResponse | null> {
  const config = getPartnerBankConfig(bank);
  const response = await fetch(
    `${config.baseUrl}/v1/banks/${config.slug}/payouts/by-idempotency/${encodeURIComponent(transferId)}`,
    {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Partner status lookup returned HTTP ${response.status}`);
  return await response.json() as PayoutResponse;
}

async function updateDispatchStatus(transferId: string, providerReference: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM account_transfers WHERE id = ${transferId}::uuid FOR UPDATE`;
    const transfer = await tx.accountTransfer.findUnique({
      where: { id: transferId },
      include: { reconciliationCase: { select: { status: true } } },
    });
    if (
      !transfer || transfer.reconciliationCase?.status === "OPEN" ||
      !["RESERVED", "UNKNOWN"].includes(transfer.status)
    ) return;
    await tx.accountTransfer.update({
      where: { id: transferId },
      data: {
        providerReference,
        status: "DISPATCHED",
        events: { create: { fromStatus: transfer.status, toStatus: "DISPATCHED" } },
      },
    });
  });
}

async function reconcilePayout(bank: PartnerBankCode, transferId: string, payout: PayoutResponse["payout"]) {
  if (payout.status === "DISPATCHED") {
    await updateDispatchStatus(transferId, payout.providerReference);
    return false;
  }

  const bankCode = partnerBankSlug(bank);
  const event = {
    eventId: `reconcile:${payout.providerReference}:${payout.status}`,
    eventType: payout.status === "COMPLETED" ? "PAYOUT_COMPLETED" as const : "PAYOUT_FAILED" as const,
    bankCode,
    bankTransferId: transferId,
    providerReference: payout.providerReference,
    status: payout.status,
    occurredAt: payout.createdAt,
  };
  await processPartnerWebhook(
    bank,
    event,
    createHash("sha256").update(JSON.stringify(event)).digest("hex"),
  );
  return true;
}

async function markUnknown(jobId: string, transferId: string, message: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM account_transfers WHERE id = ${transferId}::uuid FOR UPDATE`;
    const transfer = await tx.accountTransfer.findUnique({ where: { id: transferId } });
    if (transfer && ["RESERVED", "DISPATCHED"].includes(transfer.status)) {
      await tx.accountTransfer.update({
        where: { id: transferId },
        data: {
          status: "UNKNOWN",
          events: { create: { fromStatus: transfer.status, toStatus: "UNKNOWN", reasonCode: "PARTNER_RESPONSE_UNKNOWN" } },
        },
      });
    }
    await tx.$executeRaw`
      UPDATE outbox_jobs
      SET status = 'UNKNOWN',
          available_at = now() + (${retryDelayMs}::int * interval '1 millisecond'),
          locked_at = NULL, last_error = ${message.slice(0, 255)}, updated_at = now()
      WHERE id = ${jobId}::uuid AND status = 'PROCESSING'
    `;
  });
}

async function finishJob(jobId: string) {
  await prisma.$executeRaw`
    UPDATE outbox_jobs
    SET status = 'DONE', locked_at = NULL, last_error = NULL, updated_at = now()
    WHERE id = ${jobId}::uuid AND status = 'PROCESSING'
  `;
}

async function scheduleReconciliation(jobId: string) {
  await prisma.$executeRaw`
    UPDATE outbox_jobs
    SET status = 'UNKNOWN',
        available_at = now() + (${retryDelayMs}::int * interval '1 millisecond'),
        locked_at = NULL, last_error = 'Awaiting terminal partner status', updated_at = now()
    WHERE id = ${jobId}::uuid AND status = 'PROCESSING'
  `;
}

async function sendPayout(jobId: string, transfer: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>["job"]["accountTransfer"]) {
  if (!transfer.partnerBank || !transfer.beneficiaryName || !transfer.beneficiaryAccountNumber) {
    await markUnknown(jobId, transfer.id, "Partner payout fields are incomplete");
    return;
  }

  const bank = transfer.partnerBank as PartnerBankCode;
  try {
    const config = getPartnerBankConfig(bank);
    const previousJobStatus = await prisma.outboxJob.findUnique({ where: { id: jobId }, select: { attempts: true } });
    const mayHaveBeenSent = (previousJobStatus?.attempts ?? 1) > 1;
    if (mayHaveBeenSent) {
      const existing = await lookupPayout(bank, transfer.id);
      if (existing) {
        if (await reconcilePayout(bank, transfer.id, existing.payout)) await finishJob(jobId);
        else await scheduleReconciliation(jobId);
        return;
      }
      await flagPartnerPayoutForReview(
        bank,
        transfer.id,
        "PARTNER_NOT_FOUND_AFTER_SEND",
      );
      console.warn(`Partner payout ${transfer.id} requires review: lookup returned 404 after a possible send`);
      return;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": transfer.id,
    };
    if (process.env.BANK_SIMULATOR_MODE) headers["X-Simulator-Mode"] = process.env.BANK_SIMULATOR_MODE;

    const response = await fetch(`${config.baseUrl}/v1/banks/${config.slug}/payouts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        bankTransferId: transfer.id,
        beneficiaryName: transfer.beneficiaryName,
        accountNumber: transfer.beneficiaryAccountNumber,
        amountMinor: transfer.amountMinor.toString(),
        currency: transfer.currency,
        webhookUrl,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`Partner payout returned HTTP ${response.status}`);
    const result = await response.json() as PayoutResponse;
    if (!result.payout?.providerReference || !result.payout.status) {
      throw new Error("Partner payout response was incomplete");
    }
    if (await reconcilePayout(bank, transfer.id, result.payout)) await finishJob(jobId);
    else await scheduleReconciliation(jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown partner request error";
    await markUnknown(jobId, transfer.id, message);
    console.warn(`Partner payout ${transfer.id} requires reconciliation: ${message}`);
  }
}

async function processNext(): Promise<boolean> {
  const claimed = await claimNextJob();
  if (!claimed) return false;
  if (claimed.job.accountTransfer.status === "COMPLETED" || claimed.job.accountTransfer.status === "FAILED") {
    await finishJob(claimed.job.id);
    return true;
  }
  await sendPayout(claimed.job.id, claimed.job.accountTransfer);
  return true;
}

export function startPartnerPayoutWorker() {
  let stopping = false;
  const run = async () => {
    while (!stopping) {
      try {
        if (!(await processNext())) await delay(500);
      } catch (error) {
        console.error("Partner payout worker iteration failed:", error);
        await delay(1_000);
      }
    }
  };
  const worker = run();
  return async () => {
    stopping = true;
    await worker;
  };
}
