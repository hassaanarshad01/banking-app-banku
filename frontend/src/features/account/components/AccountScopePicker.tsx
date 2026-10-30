import type { AuthUser } from '../../auth/api/auth-api';
import './account-scope-picker.css';

export const ALL_ACCOUNT_SCOPE = 'ALL';

export type AccountScope = {
  id: string;
  label: string;
  availableBalanceMinor: string;
  lockedBalanceMinor: string;
  isMerchant: boolean;
};

export function getAccountScopes(user: AuthUser | null): AccountScope[] {
  const personal = (user?.accounts ?? []).filter((account) => account.currency === 'USD').map((account) => ({
    id: account.id,
    label: `Personal · ${account.label || `ending ${account.id.slice(-6).toUpperCase()}`}`,
    availableBalanceMinor: account.availableBalanceMinor,
    lockedBalanceMinor: account.lockedBalanceMinor,
    isMerchant: false,
  }));
  const merchants = (user?.merchantAccounts ?? []).flatMap((merchant) => merchant.account && merchant.account.currency === 'USD' ? [{
    id: merchant.account.id,
    label: `${merchant.merchantName} · @${merchant.merchantHandle}`,
    availableBalanceMinor: merchant.account.availableBalanceMinor,
    lockedBalanceMinor: merchant.account.lockedBalanceMinor,
    isMerchant: true,
  }] : []);
  return [...personal, ...merchants];
}

export function defaultAccountScope(accounts: AccountScope[]): string {
  return accounts[0]?.id ?? ALL_ACCOUNT_SCOPE;
}

export function AccountScopePicker({
  accounts,
  value,
  onChange,
  id,
}: {
  accounts: AccountScope[];
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  return <div className="account-scope-picker">
    <label htmlFor={id}>View account</label>
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
      <option value={ALL_ACCOUNT_SCOPE}>All accounts</option>
    </select>
  </div>;
}
