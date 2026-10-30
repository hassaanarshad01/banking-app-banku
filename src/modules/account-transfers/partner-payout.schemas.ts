import { z } from "zod";
import { partnerBankOptions } from "./partner-bank.config.js";

const partnerBankCodes = ["NATIONAL", "STATE", "HOLY"] as const;
const partnerBankSlugs = ["national", "state", "holy"] as const;

export const externalPayoutSchema = z.object({
  sourceAccountId: z.uuid(),
  partnerBank: z.enum(partnerBankCodes),
  beneficiaryName: z.string().trim().min(1).max(120),
  beneficiaryAccountNumber: z.string().trim().min(4).max(64),
  amountMinor: z.string().regex(/^[1-9]\d{0,18}$/),
  currency: z.literal("USD"),
}).strict();

export const partnerWebhookSchema = z.object({
  eventId: z.string().min(1).max(128),
  eventType: z.enum(["PAYOUT_DISPATCHED", "PAYOUT_COMPLETED", "PAYOUT_FAILED"]),
  bankCode: z.enum(partnerBankSlugs),
  bankTransferId: z.uuid(),
  providerReference: z.string().min(1).max(128),
  status: z.enum(["DISPATCHED", "COMPLETED", "FAILED"]),
  occurredAt: z.iso.datetime(),
}).strict().superRefine((event, context) => {
  const expectedStatus = event.eventType === "PAYOUT_DISPATCHED"
    ? "DISPATCHED"
    : event.eventType === "PAYOUT_COMPLETED" ? "COMPLETED" : "FAILED";
  if (event.status !== expectedStatus) {
    context.addIssue({ code: "custom", message: "EVENT_STATUS_MISMATCH" });
  }
});

export type ExternalPayoutInput = z.infer<typeof externalPayoutSchema>;
export type PartnerWebhook = z.infer<typeof partnerWebhookSchema>;
