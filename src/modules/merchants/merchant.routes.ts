import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../auth/auth.middleware.js";
import { createMerchantController, listMerchantsController } from "./merchant.controller.js";

const router = Router();
const merchantRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

router.get("/", requireAuth, listMerchantsController);
router.post("/", requireAuth, merchantRateLimit, createMerchantController);

export { router as merchantRoutes };
