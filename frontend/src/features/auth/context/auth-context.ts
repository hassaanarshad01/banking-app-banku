import { createContext } from 'react';
import type { AuthUser } from '../api/auth-api';

export type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  signup(fullName: string, phoneNumber: string, email: string, password: string, dateOfBirth: string): Promise<void>;
  updateProfile(input: { fullName: string; email: string; phoneNumber: string }): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
