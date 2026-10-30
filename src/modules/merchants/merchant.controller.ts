import type { RequestHandler } from "express";
import { createMerchantSchema } from "./merchant.schemas.js";
import { createMerchant, listMyMerchants, MerchantError } from "./merchant.service.js";

export const createMerchantController: RequestHandler = async (request, response, next) => {
  const parsed = createMerchantSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }
  try {
    const merchant = await createMerchant(response.locals.authenticatedUser.id, parsed.data);
    response.status(201).json({ merchant });
  } catch (error) {
    if (error instanceof MerchantError) {
      response.status(error.code === "MERCHANT_HANDLE_TAKEN" ? 409 : 403).json({ error: error.code });
      return;
    }
    next(error);
  }
};

export const listMerchantsController: RequestHandler = async (_request, response, next) => {
  try {
    const merchants = await listMyMerchants(response.locals.authenticatedUser.id);
    response.json({ merchants });
  } catch (error) {
    next(error);
  }
};
