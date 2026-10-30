import { apiRequest } from '../../../shared/api/api-client';

export type TransferRecipient = {
  kind: 'CUSTOMER' | 'MERCHANT';
  id: string;
  accountId: string;
  fullName: string | null;
  phoneNumber: string | null;
  email: string | null;
  merchantHandle: string | null;
};

export type AccountTransferResult = {
  id: string;
  sourceAccountId?: string;
  destinationAccountId?: string | null;
  amountMinor: string;
  currency: string;
  transferType: string;
  status: string;
  partnerBank?: string | null;
  providerReference?: string | null;
  rejectionCode?: string | null;
  reconciliationRequired?: boolean;
  partnerReconciliation?: {
    status: string;
    firstStatus: string;
    latestStatus: string;
    reasonCode: string;
  } | null;
  createdAt?: string;
  completedAt: string | null;
};

export type AccountActivity = {
  id: string;
  amountMinor: string;
  currency: string;
  transferType: string;
  partnerBank: string | null;
  direction: 'INCOMING' | 'OUTGOING' | 'INTERNAL';
  counterpartyName: string | null;
  accountLabel?: string | null;
  providerReference: string | null;
  status: string;
  rejectionCode: string | null;
  reconciliationRequired: boolean;
  partnerReconciliation: AccountTransferResult['partnerReconciliation'];
  createdAt: string;
  completedAt: string | null;
};

export type AccountActivitySummary = {
  months: { month: string; debitsMinor: string; creditsMinor: string }[];
  debitMix: { category: 'PEOPLE' | 'BUSINESSES' | 'PARTNER_BANKS' | 'OTHER'; amountMinor: string }[];
};

export type CashflowMonth = AccountActivitySummary['months'][number];
export type DebitMixItem = AccountActivitySummary['debitMix'][number];

export const partnerBanks = [
  { code: 'NATIONAL', name: 'National Bank' },
  { code: 'STATE', name: 'State Bank' },
  { code: 'HOLY', name: 'Holy Bank' },
] as const;

export const accountTransferApi = {
  lookupRecipient(recipient: string) {
    return apiRequest<{ recipient: TransferRecipient }>('/api/account-transfers/recipient-lookup', {
      method: 'POST',
      body: JSON.stringify({ recipient }),
    });
  },

  create(input: {
    sourceAccountId: string;
    destinationAccountId: string;
    amountMinor: string;
    currency: string;
    idempotencyKey: string;
  }) {
    const { idempotencyKey, ...body } = input;
    return apiRequest<{ accountTransfer: AccountTransferResult; replayed: boolean }>('/api/account-transfers', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
  },

  createPartnerPayout(input: {
    sourceAccountId: string;
    partnerBank: (typeof partnerBanks)[number]['code'];
    beneficiaryName: string;
    beneficiaryAccountNumber: string;
    amountMinor: string;
    currency: string;
    idempotencyKey: string;
  }) {
    const { idempotencyKey, ...body } = input;
    return apiRequest<{ accountTransfer: AccountTransferResult; replayed: boolean }>('/api/account-transfers/partner-payouts', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
  },

  status(transferId: string) {
    return apiRequest<{ accountTransfer: AccountTransferResult }>(`/api/account-transfers/${encodeURIComponent(transferId)}`);
  },

  list(accountId?: string) {
    const query = accountId ? `?${new URLSearchParams({ accountId })}` : '';
    return apiRequest<{ accountTransfers: AccountActivity[] }>(`/api/account-transfers${query}`);
  },

  summary(accountId?: string) {
    const query = accountId ? `?${new URLSearchParams({ accountId })}` : '';
    return apiRequest<{ summary: AccountActivitySummary }>(`/api/account-transfers/summary${query}`);
  },

  cashflow(accountId?: string) {
    const query = accountId ? `?${new URLSearchParams({ accountId })}` : '';
    return apiRequest<{ months: CashflowMonth[] }>(`/api/account-transfers/summary/cashflow${query}`);
  },

  debitMix(accountId?: string) {
    const query = accountId ? `?${new URLSearchParams({ accountId })}` : '';
    return apiRequest<{ debitMix: DebitMixItem[] }>(`/api/account-transfers/summary/debit-mix${query}`);
  },

  retryPartnerPayout(transferId: string) {
    return apiRequest<{ accountTransfer: AccountTransferResult; replayed: boolean }>(
      `/api/account-transfers/${encodeURIComponent(transferId)}/retry`,
      { method: 'POST' },
    );
  },
};
