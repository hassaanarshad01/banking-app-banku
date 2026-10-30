import "dotenv/config";
import { app } from "./api/app.js";
import { prisma } from "./db/prisma.js";
import { startPartnerPayoutWorker } from "./workers/partner-payout-worker.js";
import { startMerchantCreditWorker } from "./workers/merchant-credit-worker.js";

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port");
}

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Banku API listening at http://127.0.0.1:${port}`);
});
const stopPartnerPayoutWorker = startPartnerPayoutWorker();
const stopMerchantCreditWorker = startMerchantCreditWorker();

async function shutdown() {
  server.close(async () => {
    await stopPartnerPayoutWorker();
    await stopMerchantCreditWorker();
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
