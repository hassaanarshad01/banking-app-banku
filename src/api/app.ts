import express from "express";
import helmet from "helmet";
import { errorHandler } from "../middleware/error-handler.js";
import { authRoutes } from "../modules/auth/auth.routes.js";
import { accountTransferRoutes } from "../modules/account-transfers/account-transfer.routes.js";
import { partnerWebhookController } from "../modules/account-transfers/partner-webhook.controller.js";
import { merchantRoutes } from "../modules/merchants/merchant.routes.js";

export const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.post("/api/webhooks/partner-banks", express.raw({ type: "application/json", limit: "10kb" }), partnerWebhookController);
app.use(express.json({ limit: "10kb" }));
app.use("/api/auth", authRoutes);
app.use("/api/account-transfers", accountTransferRoutes);
app.use("/api/merchants", merchantRoutes);
app.use(errorHandler);
