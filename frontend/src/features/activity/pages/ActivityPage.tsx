import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '../../../shared/api/api-client';
import { BankuHeader } from '../../../shared/components/BankuHeader';
import { useAuth } from '../../auth/context/useAuth';
import { AccountScopePicker, ALL_ACCOUNT_SCOPE, defaultAccountScope, getAccountScopes } from '../../account/components/AccountScopePicker';
import { accountTransferApi, type AccountActivity } from '../../transfers/api/account-transfer-api';
import { ActivityCashflowGraph } from '../components/ActivityCashflowGraph';
import { ActivityDebitMixGraph } from '../components/ActivityDebitMixGraph';
import { ActivityList } from '../components/ActivityList';
import './activity.css';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'INSUFFICIENT_FUNDS') {
    return 'Your available balance is too low for this retry.';
  }
  if (error instanceof ApiError && error.code === 'ACCOUNT_TRANSFER_NOT_RETRYABLE') {
    return 'This payout is no longer eligible for retry.';
  }
  return 'Could not start the retry. Refresh activity to check its current status.';
}

export function ActivityPage() {
  const { user, refresh } = useAuth();
  const accounts = getAccountScopes(user);
  const [searchParams, setSearchParams] = useSearchParams();
  const initialScope = searchParams.get('accountId') ?? defaultAccountScope(accounts);
  const [accountScopeId, setAccountScopeId] = useState(initialScope);
  const selectedScope = accountScopeId === ALL_ACCOUNT_SCOPE || accounts.some((account) => account.id === accountScopeId)
    ? accountScopeId
    : defaultAccountScope(accounts);
  const [items, setItems] = useState<AccountActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const seenStatuses = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await accountTransferApi.list(selectedScope === ALL_ACCOUNT_SCOPE ? undefined : selectedScope);
        if (!active) return;
        let balanceChanged = false;
        for (const transfer of response.accountTransfers) {
          const previousStatus = seenStatuses.current.get(transfer.id);
          if (previousStatus && ['RESERVED', 'DISPATCHED', 'UNKNOWN'].includes(previousStatus) && !['RESERVED', 'DISPATCHED', 'UNKNOWN'].includes(transfer.status)) {
            balanceChanged = true;
          }
          seenStatuses.current.set(transfer.id, transfer.status);
        }
        if (balanceChanged) void refresh().catch(() => {});
        setItems(response.accountTransfers);
        setError('');
        const pending = response.accountTransfers.some((item) =>
          ['RESERVED', 'DISPATCHED', 'UNKNOWN'].includes(item.status) && !item.reconciliationRequired,
        );
        const needsReview = response.accountTransfers.some((item) => item.reconciliationRequired);
        if (pending || needsReview) {
          timer = window.setTimeout(load, pending ? 2_500 : 15_000);
        }
      } catch (caught) {
        if (!active) return;
        setError('Could not load activity. Check your connection and try again.');
        timer = window.setTimeout(load, 5_000);
      } finally {
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    setItems([]);
    void load();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [reload, refresh, selectedScope]);

  useEffect(() => {
    if (selectedScope !== accountScopeId) setAccountScopeId(selectedScope);
    if (searchParams.get('accountId') !== selectedScope) {
      const next = new URLSearchParams(searchParams);
      next.set('accountId', selectedScope);
      setSearchParams(next, { replace: true });
    }
  }, [accountScopeId, searchParams, selectedScope, setSearchParams]);

  async function retryPayout(transferId: string) {
    setRetryingId(transferId);
    setError('');
    setNotice('');
    try {
      const response = await accountTransferApi.retryPartnerPayout(transferId);
      setNotice(response.replayed ? 'This retry is already recorded. Its status is shown below.' : 'Retry started. We’ll update its status here.');
      void refresh().catch(() => {});
      setReload((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
      setReload((value) => value + 1);
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <main className="account-page-shell">
      <BankuHeader />
      <section className="account-page-content">
        <p className="account-page-eyebrow">YOUR MONEY</p>
        <h1>Activity</h1>
        <p className="account-page-intro">Filter transfers by personal or merchant account, or view them together.</p>
        <AccountScopePicker accounts={accounts} value={selectedScope} onChange={(value) => {
          setLoading(true);
          setItems([]);
          setAccountScopeId(value);
          const next = new URLSearchParams(searchParams);
          next.set('accountId', value);
          setSearchParams(next);
        }} id="activity-account-scope" />
        <div className="activity-graphs">
          <ActivityCashflowGraph accountId={selectedScope === ALL_ACCOUNT_SCOPE ? undefined : selectedScope} />
          <ActivityDebitMixGraph accountId={selectedScope === ALL_ACCOUNT_SCOPE ? undefined : selectedScope} />
        </div>
        {notice && <p className="activity-notice" role="status">{notice}</p>}
        {error && <p className="activity-page-error" role="alert">{error}</p>}
        <section className="activity-page-panel" aria-label="Transfer history">
          {loading ? <p className="activity-page-loading">Loading your transfers…</p> : <ActivityList items={items} onRetry={retryPayout} retryingId={retryingId} />}
        </section>
      </section>
    </main>
  );
}
