import "dotenv/config";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";

const maxPostgresBigInt = 9_223_372_036_854_775_807n;
const banks = {
  national: {
    name: "National Bank",
    apiKey: process.env.NATIONAL_BANK_API_KEY,
    webhookSecret: process.env.NATIONAL_BANK_WEBHOOK_SECRET,
  },
  state: {
    name: "State Bank",
    apiKey: process.env.STATE_BANK_API_KEY,
    webhookSecret: process.env.STATE_BANK_WEBHOOK_SECRET,
  },
  holy: {
    name: "Holy Bank",
    apiKey: process.env.HOLY_BANK_API_KEY,
    webhookSecret: process.env.HOLY_BANK_WEBHOOK_SECRET,
  },
} as const;

type BankCode = keyof typeof banks;
type SimulatorMode = "success" | "reject" | "delay" | "http_500" | "duplicate_webhook" | "out_of_order";
type Payout = {
  id: string;
  bankCode: BankCode;
  bankTransferId: string;
  providerReference: string;
  beneficiaryName: string;
  accountNumber: string;
  amountMinor: string;
  currency: string;
  status: "DISPATCHED" | "COMPLETED" | "FAILED";
  finalStatus: "COMPLETED" | "FAILED";
  createdAt: string;
  webhookUrl: string;
};

const payoutsByIdempotency = new Map<string, { requestHash: string; payout: Payout }>();
const payoutsByReference = new Map<string, Payout>();

function equalSecret(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function getBank(value: string | undefined): [BankCode, (typeof banks)[BankCode]] | null {
  if (value && Object.hasOwn(banks, value)) {
    const code = value as BankCode;
    return [code, banks[code]];
  }
  return null;
}

function requireBankKey(request: express.Request, bank: (typeof banks)[BankCode]): boolean {
  const header = request.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  return Boolean(bank.apiKey && equalSecret(bank.apiKey, token));
}

function validateWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isPayoutBody(value: unknown): value is {
  bankTransferId: string;
  beneficiaryName: string;
  accountNumber: string;
  amountMinor: string;
  currency: "USD";
  webhookUrl: string;
} {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (typeof body.amountMinor !== "string" || !/^[1-9]\d{0,18}$/.test(body.amountMinor)) return false;
  if (BigInt(body.amountMinor) > maxPostgresBigInt) return false;
  return typeof body.bankTransferId === "string" && body.bankTransferId.length <= 64 &&
    typeof body.beneficiaryName === "string" && body.beneficiaryName.trim().length > 0 && body.beneficiaryName.length <= 120 &&
    typeof body.accountNumber === "string" && body.accountNumber.trim().length >= 4 && body.accountNumber.length <= 64 &&
    body.currency === "USD" && validateWebhookUrl(body.webhookUrl);
}

function signEvent(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function sendWebhook(
  payout: Payout,
  eventType: "PAYOUT_DISPATCHED" | "PAYOUT_COMPLETED" | "PAYOUT_FAILED",
  eventId: string,
  occurredAt = new Date().toISOString(),
) {
  const bank = banks[payout.bankCode];
  const event = {
    eventId,
    eventType,
    bankCode: payout.bankCode,
    bankTransferId: payout.bankTransferId,
    providerReference: payout.providerReference,
    status: eventType === "PAYOUT_COMPLETED" ? "COMPLETED" : eventType === "PAYOUT_FAILED" ? "FAILED" : "DISPATCHED",
    occurredAt,
  };
  const rawBody = JSON.stringify(event);
  const signature = signEvent(bank.webhookSecret!, rawBody);

  try {
    const response = await fetch(payout.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bank-Webhook-Signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) console.warn(`Webhook ${eventId} returned HTTP ${response.status}`);
  } catch (error) {
    console.warn(`Webhook ${eventId} delivery failed:`, error);
  }
}

async function emitWebhooks(payout: Payout, mode: SimulatorMode) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (mode !== "out_of_order") await sendWebhook(payout, "PAYOUT_DISPATCHED", randomUUID());
  await new Promise((resolve) => setTimeout(resolve, 50));
  const eventType = payout.finalStatus === "FAILED" ? "PAYOUT_FAILED" : "PAYOUT_COMPLETED";
  if (mode === "out_of_order") {
    payout.status = payout.finalStatus;
    await sendWebhook(payout, eventType, `${payout.providerReference}:terminal`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sendWebhook(payout, "PAYOUT_DISPATCHED", `${payout.providerReference}:dispatched`);
    return;
  }

  payout.status = payout.finalStatus;
  if (mode === "duplicate_webhook") {
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    for (let index = 0; index < 3; index += 1) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 50));
      await sendWebhook(payout, eventType, eventId, occurredAt);
    }
    return;
  }
  await sendWebhook(payout, eventType, randomUUID());
}

function publicPayout(payout: Payout) {
  return {
    id: payout.id,
    bankTransferId: payout.bankTransferId,
    providerReference: payout.providerReference,
    amountMinor: payout.amountMinor,
    currency: payout.currency,
    status: payout.status,
    createdAt: payout.createdAt,
  };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/v1/banks", (_request, response) => {
  response.json({ banks: Object.entries(banks).map(([code, bank]) => ({ code, name: bank.name })) });
});

app.post("/v1/banks/:bankCode/payouts", async (request, response) => {
  const entry = getBank(request.params.bankCode);
  if (!entry) {
    response.status(404).json({ error: "BANK_NOT_FOUND" });
    return;
  }
  const [bankCode, bank] = entry;
  if (!requireBankKey(request, bank)) {
    response.status(401).json({ error: "INVALID_PARTNER_API_KEY" });
    return;
  }
  const idempotencyKey = request.get("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length > 255 || !isPayoutBody(request.body)) {
    response.status(400).json({ error: "INVALID_PAYOUT_REQUEST" });
    return;
  }

  const modeHeader = request.get("X-Simulator-Mode") ?? "success";
  const modes: SimulatorMode[] = ["success", "reject", "delay", "http_500", "duplicate_webhook", "out_of_order"];
  if (!modes.includes(modeHeader as SimulatorMode)) {
    response.status(400).json({ error: "INVALID_SIMULATOR_MODE" });
    return;
  }
  const mode = modeHeader as SimulatorMode;
  const requestHash = createHash("sha256").update(JSON.stringify(request.body)).digest("hex");
  const key = `${bankCode}:${idempotencyKey}`;
  const existing = payoutsByIdempotency.get(key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      response.status(409).json({ error: "IDEMPOTENCY_KEY_REUSED" });
      return;
    }
    response.status(202).json({ payout: publicPayout(existing.payout), replayed: true });
    return;
  }

  const payout: Payout = {
    id: randomUUID(),
    bankCode,
    bankTransferId: request.body.bankTransferId,
    providerReference: `${bankCode.toUpperCase()}-${randomUUID()}`,
    beneficiaryName: request.body.beneficiaryName.trim(),
    accountNumber: request.body.accountNumber.trim(),
    amountMinor: request.body.amountMinor,
    currency: request.body.currency,
    status: "DISPATCHED",
    finalStatus: mode === "reject" ? "FAILED" : "COMPLETED",
    createdAt: new Date().toISOString(),
    webhookUrl: request.body.webhookUrl,
  };
  payoutsByIdempotency.set(key, { requestHash, payout });
  payoutsByReference.set(payout.providerReference, payout);
  void emitWebhooks(payout, mode);

  if (mode === "delay") await new Promise((resolve) => setTimeout(resolve, 12_000));
  if (mode === "http_500") {
    response.status(500).json({ error: "SIMULATED_AMBIGUOUS_FAILURE" });
    return;
  }
  response.status(202).json({
    payout: publicPayout(payout),
    replayed: false,
  });
});

app.get("/v1/banks/:bankCode/payouts/by-idempotency/:idempotencyKey", (request, response) => {
  const entry = getBank(request.params.bankCode);
  if (!entry) {
    response.status(404).json({ error: "BANK_NOT_FOUND" });
    return;
  }
  const [bankCode, bank] = entry;
  if (!requireBankKey(request, bank)) {
    response.status(401).json({ error: "INVALID_PARTNER_API_KEY" });
    return;
  }
  const result = payoutsByIdempotency.get(`${bankCode}:${request.params.idempotencyKey}`);
  if (!result) {
    response.status(404).json({ error: "PAYOUT_NOT_FOUND" });
    return;
  }
  response.json({ payout: publicPayout(result.payout) });
});

app.get("/v1/banks/:bankCode/payouts/:providerReference", (request, response) => {
  const entry = getBank(request.params.bankCode);
  if (!entry) {
    response.status(404).json({ error: "BANK_NOT_FOUND" });
    return;
  }
  const [bankCode, bank] = entry;
  if (!requireBankKey(request, bank)) {
    response.status(401).json({ error: "INVALID_PARTNER_API_KEY" });
    return;
  }
  const payout = payoutsByReference.get(request.params.providerReference);
  if (!payout || payout.bankCode !== bankCode) {
    response.status(404).json({ error: "PAYOUT_NOT_FOUND" });
    return;
  }
  response.json({ payout: publicPayout(payout) });
});

const port = Number(process.env.BANK_SIMULATOR_PORT ?? 4001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("BANK_SIMULATOR_PORT must be a valid TCP port");
for (const [code, bank] of Object.entries(banks)) {
  if (!bank.apiKey || !bank.webhookSecret) throw new Error(`Missing API key or webhook secret for ${code} bank`);
}
if (new Set(Object.values(banks).map((bank) => bank.apiKey)).size !== 3) {
  throw new Error("Each simulated bank must have its own distinct API key");
}
if (new Set(Object.values(banks).map((bank) => bank.webhookSecret)).size !== 3) {
  throw new Error("Each simulated bank must have its own distinct webhook secret");
}

app.listen(port, "127.0.0.1", () => {
  console.log(`Partner bank simulator listening at http://127.0.0.1:${port}`);
});
