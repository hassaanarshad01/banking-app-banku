import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { AccountTransferError } from "./account-transfer.errors.js";
import { getPartnerBankConfig, partnerBankCodeFromSlug } from "./partner-bank.config.js";
import { partnerWebhookSchema } from "./partner-payout.schemas.js";
import { processPartnerWebhook } from "./partner-payout.service.js";

export const partnerWebhookController: RequestHandler = async (request, response, next) => {
  if (!Buffer.isBuffer(request.body)) {
    response.status(400).json({ error: "INVALID_WEBHOOK_BODY" });
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(request.body.toString("utf8"));
  } catch {
    response.status(400).json({ error: "INVALID_WEBHOOK_BODY" });
    return;
  }
  const parsed = partnerWebhookSchema.safeParse(parsedJson);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_WEBHOOK" });
    return;
  }

  const partnerBank = partnerBankCodeFromSlug(parsed.data.bankCode);
  if (!partnerBank) {
    response.status(400).json({ error: "INVALID_WEBHOOK" });
    return;
  }

  try {
    const config = getPartnerBankConfig(partnerBank);
    const signature = request.get("X-Bank-Webhook-Signature") ?? "";
    const expected = createHmac("sha256", config.webhookSecret).update(request.body).digest();
    const supplied = /^[a-f0-9]{64}$/i.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      response.status(401).json({ error: "INVALID_WEBHOOK_SIGNATURE" });
      return;
    }

    const result = await processPartnerWebhook(
      partnerBank,
      parsed.data,
      createHash("sha256").update(request.body).digest("hex"),
    );
    response.status(200).json({ received: true, ...result });
  } catch (error) {
    if (error instanceof AccountTransferError) {
      const status = error.code === "PROVIDER_REFERENCE_REUSED" || error.code === "WEBHOOK_EVENT_ID_REUSED" ? 409 : 400;
      response.status(status).json({ error: error.code });
      return;
    }
    next(error);
  }
};
