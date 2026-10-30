import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ActivityList } from '../../activity/components/ActivityList';
import { accountTransferApi, type AccountActivity, type AccountActivitySummary } from '../../transfers/api/account-transfer-api';
import { AccountScopePicker, ALL_ACCOUNT_SCOPE, defaultAccountScope, getAccountScopes } from '../../account/components/AccountScopePicker';
import { AccountInsights } from '../components/AccountInsights';
import { BankuHeader } from '../../../shared/components/BankuHeader';
import { useAuth } from '../../auth/context/useAuth';
import './dashboard.css';

function formatUsd(minorUnits: string): string {
  const minor = BigInt(minorUnits);
  return `$${(minor / 100n).toLocaleString('en-US')}.${(minor % 100n).toString().padStart(2, '0')}`;
}

export function DashboardPage() {
  const { user, refresh } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const accountScopes = getAccountScopes(user);
  const [accountScopeId, setAccountScopeId] = useState(() => searchParams.get('accountId') ?? defaultAccountScope(getAccountScopes(user)));
  const accountScopeInitialized = useRef(accountScopes.length > 0);
  const selectedAccounts = accountScopeId === ALL_ACCOUNT_SCOPE
    ? accountScopes
    : accountScopes.filter((account) => account.id === accountScopeId);
  const selectedAccount = accountScopeId === ALL_ACCOUNT_SCOPE
    ? undefined
    : accountScopes.find((account) => account.id === accountScopeId);
  const availableBalanceMinor = selectedAccounts.reduce((total, account) => total + BigInt(account.availableBalanceMinor), 0n).toString();
  const lockedBalanceMinor = selectedAccounts.reduce((total, account) => total + BigInt(account.lockedBalanceMinor), 0n).toString();
  const [activity, setActivity] = useState<AccountActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState('');
  const [summary, setSummary] = useState<AccountActivitySummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState(false);
  const [summaryRefresh, setSummaryRefresh] = useState(0);
  const seenStatuses = useRef(new Map<string, string>());

  useEffect(() => {
    if (!accountScopeInitialized.current && accountScopes.length > 0) {
      accountScopeInitialized.current = true;
      setAccountScopeId(defaultAccountScope(accountScopes));
    } else if (accountScopeId !== ALL_ACCOUNT_SCOPE && !accountScopes.some((account) => account.id === accountScopeId)) {
      const fallback = defaultAccountScope(accountScopes);
      setAccountScopeId(fallback);
      const next = new URLSearchParams(searchParams);
      next.set('accountId', fallback);
      setSearchParams(next, { replace: true });
    }
  }, [accountScopeId, accountScopes, searchParams, setSearchParams]);

  function changeAccountScope(value: string) {
    setAccountScopeId(value);
    const next = new URLSearchParams(searchParams);
    next.set('accountId', value);
    setSearchParams(next);
  }

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        setActivityLoading(true);
        setActivity([]);
        const response = await accountTransferApi.list(accountScopeId === ALL_ACCOUNT_SCOPE ? undefined : accountScopeId);
        if (!active) return;
        let balanceChanged = false;
        for (const transfer of response.accountTransfers) {
          const previousStatus = seenStatuses.current.get(transfer.id);
          if (previousStatus && ['RESERVED', 'DISPATCHED', 'UNKNOWN'].includes(previousStatus) && !['RESERVED', 'DISPATCHED', 'UNKNOWN'].includes(transfer.status)) balanceChanged = true;
          seenStatuses.current.set(transfer.id, transfer.status);
        }
        if (balanceChanged) {
          void refresh().catch(() => {});
          setSummaryRefresh((current) => current + 1);
        }
        const recent = response.accountTransfers.slice(0, 5);
        setActivity(recent);
        setActivityError('');
        const pending = recent.some((item) =>
          ['RESERVED', 'DISPATCHED', 'UNKNOWN'].includes(item.status) && !item.reconciliationRequired,
        );
        const needsReview = recent.some((item) => item.reconciliationRequired);
        if (pending || needsReview) timer = window.setTimeout(load, pending ? 2_500 : 15_000);
      } catch {
        if (!active) return;
        setActivityError('Recent activity is temporarily unavailable.');
        timer = window.setTimeout(load, 5_000);
      } finally {
        if (active) setActivityLoading(false);
      }
    };
    void load();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [refresh, accountScopeId]);

  useEffect(() => {
    let active = true;
    setSummary(null);
    setSummaryError(false);
    setSummaryLoading(true);
    if (selectedAccounts.length > 0) {
      accountTransferApi.summary(accountScopeId === ALL_ACCOUNT_SCOPE ? undefined : accountScopeId)
        .then(({ summary: loaded }) => { if (active) setSummary(loaded); })
        .catch(() => { if (active) { setSummary(null); setSummaryError(true); } })
        .finally(() => { if (active) setSummaryLoading(false); });
    } else {
      setSummaryLoading(false);
    }
    return () => { active = false; };
  }, [accountScopeId, summaryRefresh]);

  return (
    <main className="dashboard-shell">
      <BankuHeader />
      <div className="dashboard-content">
        <section className="dashboard-intro">
          <p className="dashboard-eyebrow">YOUR BANKU SPACE</p>
          <h1>Welcome{user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}.</h1>
          <p>Here’s your money at a glance.</p>
        </section>
        <AccountScopePicker accounts={accountScopes} value={accountScopeId} onChange={changeAccountScope} id="dashboard-account-scope" />
        <section className="dashboard-money-card" aria-label="USD account balance">
          <div className="dashboard-money-copy">
            <p className="balance-label">{accountScopeId === ALL_ACCOUNT_SCOPE ? 'TOTAL AVAILABLE · USD' : 'AVAILABLE BALANCE · USD'}</p>
            <strong>{formatUsd(availableBalanceMinor)}</strong>
            <p>{selectedAccount?.label ?? (accountScopes.length > 0 ? `${accountScopes.length} USD account${accountScopes.length === 1 ? '' : 's'} combined` : 'Banku USD account')}</p>
          </div>
          <Link className="dashboard-send-button" to={selectedAccount ? `/transfers?from=${encodeURIComponent(selectedAccount.id)}` : '/transfers'}>Send money <span aria-hidden="true">→</span></Link>
          <div className="dashboard-reserved">
            <span>Reserved for pending transfers</span>
            <strong>{formatUsd(lockedBalanceMinor)}</strong>
          </div>
        </section>
        {summaryLoading
          ? <section className="dashboard-insights dashboard-insights-loading" aria-label="Account activity summary"><p>Preparing your six-month summary…</p></section>
          : summary
            ? <AccountInsights summary={summary} />
            : summaryError && <section className="dashboard-insights dashboard-insights-loading" role="status"><p>Your account summary is temporarily unavailable.</p></section>}
        <section className="dashboard-activity-panel" aria-labelledby="recent-activity-title">
          <div className="dashboard-section-heading">
            <div><p className="dashboard-eyebrow">MONEY MOVEMENT</p><h2 id="recent-activity-title">Recent activity</h2></div>
            <Link to={`/activity?accountId=${encodeURIComponent(accountScopeId)}`}>All activity <span aria-hidden="true">→</span></Link>
          </div>
          {activityLoading
            ? <p className="dashboard-activity-message">Loading your activity…</p>
            : activityError
              ? <p className="dashboard-activity-message" role="status">{activityError}</p>
              : <ActivityList items={activity.slice(0, 3)} />}
        </section>
        <Link className="dashboard-account-link" to="/account">
          <span className="dashboard-account-icon" aria-hidden="true">◎</span>
          <span><strong>Account information</strong><small>Review your profile and account details</small></span>
          <span aria-hidden="true">→</span>
        </Link>
        <Link className="dashboard-account-link" to="/merchants">
          <span className="dashboard-account-icon" aria-hidden="true">↗</span>
          <span><strong>Merchant accounts</strong><small>Create a business account and manage its balance</small></span>
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </main>
  );
}
