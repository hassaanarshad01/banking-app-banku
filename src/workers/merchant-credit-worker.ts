import { prisma } from "../db/prisma.js";
import { applyPendingMerchantCreditBatch } from "../modules/account-transfers/merchant-credit-projection.js";

const batchSize = 250;
const intervalMs = 250;

export async function processMerchantCreditBatch() {
  return prisma.$transaction(async (tx) => {
    const accounts = await tx.$queryRaw<Array<{ id: string }>>`
      WITH candidate_accounts AS (
        SELECT merchant_account_id
        FROM merchant_credit_projections
        WHERE status = 'PENDING'
        GROUP BY merchant_account_id
        ORDER BY MIN(created_at), merchant_account_id
        LIMIT ${batchSize}
      )
      SELECT account.id
      FROM accounts account
      JOIN candidate_accounts candidate ON candidate.merchant_account_id = account.id
      WHERE account.kind = 'MERCHANT'
      ORDER BY account.id
      FOR NO KEY UPDATE OF account SKIP LOCKED
    `;
    if (accounts.length === 0) return 0;

    let remaining = batchSize;
    let processed = 0;
    for (let index = 0; index < accounts.length && remaining > 0; index += 1) {
      const account = accounts[index];
      if (!account) continue;
      const accountsRemaining = accounts.length - index;
      const limit = Math.ceil(remaining / accountsRemaining);
      const result = await applyPendingMerchantCreditBatch(tx, account.id, limit);
      remaining -= result.count;
      processed += result.count;
    }
    return processed;
  });
}

export function startMerchantCreditWorker() {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await processMerchantCreditBatch();
    } catch (error) {
      console.error("Merchant credit projection batch failed", error);
    } finally {
      running = false;
    }
  };

  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  return async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 10));
  };
}
