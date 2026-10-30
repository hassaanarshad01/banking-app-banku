import { z } from "zod";

export const createMerchantSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  handle: z.string().trim().toLowerCase().min(3).max(32)
    .regex(/^(?=.*[a-z])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
}).strict();

export type CreateMerchantInput = z.infer<typeof createMerchantSchema>;
