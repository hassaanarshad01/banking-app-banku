import { z } from "zod";

export const createAccountTransferSchema = z.object({
  sourceAccountId: z.uuid(),
  destinationAccountId: z.uuid(),
  // Money is transported as a decimal string to avoid JavaScript number precision loss.
  amountMinor: z.string().regex(/^[1-9]\d{0,18}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const recipientLookupSchema = z.object({
  recipient: z.string().trim().min(1).max(254),
}).strict();

export const accountSummaryQuerySchema = z.object({
  accountId: z.uuid().optional(),
}).strict();

export const accountTransferListQuerySchema = z.object({
  accountId: z.uuid().optional(),
}).strict();

export type CreateAccountTransferRequest = z.infer<typeof createAccountTransferSchema>;
