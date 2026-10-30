import { apiRequest } from '../../../shared/api/api-client';
import type { AuthAccount } from '../../auth/api/auth-api';

export type Merchant = {
  id: string;
  handle: string;
  displayName: string;
  status: string;
  createdAt: string;
  role: string;
  account: (AuthAccount & { pendingCreditsMinor?: string }) | null;
};

export const merchantApi = {
  list() {
    return apiRequest<{ merchants: Merchant[] }>('/api/merchants');
  },

  create(input: { displayName: string; handle: string }) {
    return apiRequest<{ merchant: Merchant }>('/api/merchants', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
};
