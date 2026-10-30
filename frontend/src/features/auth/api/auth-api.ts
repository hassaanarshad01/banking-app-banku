import { apiRequest, ApiError } from '../../../shared/api/api-client';

export type AuthAccount = {
  id: string;
  label: string | null;
  currency: string;
  availableBalanceMinor: string;
  pendingCreditsMinor?: string;
  lockedBalanceMinor: string;
  status: string;
  createdAt: string;
};

export type MerchantAccount = {
  merchantId: string;
  merchantName: string;
  merchantHandle: string;
  merchantStatus: string;
  role: string;
  account: AuthAccount | null;
};

export type AuthUser = {
  id: string;
  fullName: string | null;
  phoneNumber: string | null;
  email: string;
  dateOfBirth: string | null;
  createdAt: string;
  accounts: AuthAccount[];
  merchantAccounts: MerchantAccount[];
};
type UserResponse = { user: AuthUser };

export const authApi = {
  signup(fullName: string, phoneNumber: string, email: string, password: string, dateOfBirth: string) {
    return apiRequest<UserResponse>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ fullName, phoneNumber, email, password, dateOfBirth }),
    });
  },

  login(email: string, password: string) {
    return apiRequest<UserResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  updateProfile(input: { fullName: string; email: string; phoneNumber: string }) {
    return apiRequest<UserResponse>('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  async me(): Promise<AuthUser | null> {
    try {
      const response = await apiRequest<UserResponse>('/api/auth/me');
      return response.user;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },

  logout() {
    return apiRequest<null>('/api/auth/logout', { method: 'POST' });
  },
};
