import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../auth/auth.middleware.js";
import {
  accountTransferStatusController,
  accountTransferListController,
  accountActivitySummaryController,
  accountCashflowController,
  accountDebitMixController,
  createAccountTransferController,
  createPartnerPayoutController,
  recipientLookupController,
  retryPartnerPayoutController,
} from "./account-transfer.controller.js";

const router = Router();

const transferRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "TOO_MANY_REQUESTS" },
});

const recipientLookupRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "TOO_MANY_LOOKUPS" },
});

router.post("/recipient-lookup", requireAuth, recipientLookupRateLimit, recipientLookupController);
router.post("/partner-payouts", requireAuth, transferRateLimit, createPartnerPayoutController);
router.post("/:transferId/retry", requireAuth, transferRateLimit, retryPartnerPayoutController);
router.get("/summary", requireAuth, accountActivitySummaryController);
router.get("/summary/cashflow", requireAuth, accountCashflowController);
router.get("/summary/debit-mix", requireAuth, accountDebitMixController);
router.get("/", requireAuth, accountTransferListController);
router.post("/", requireAuth, transferRateLimit, createAccountTransferController);
router.get("/:transferId", requireAuth, accountTransferStatusController);

export { router as accountTransferRoutes };
