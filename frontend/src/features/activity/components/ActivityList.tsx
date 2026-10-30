import { partnerBanks, type AccountActivity } from '../../transfers/api/account-transfer-api';
import './activity-list.css';

function money(minor: string, currency: string): string {
  const amount = BigInt(minor);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${(amount / 100n).toLocaleString('en-US')}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function statusLabel(status: string, reconciliationRequired: boolean): string {
  if (reconciliationRequired) {
    return status === 'COMPLETED' || status === 'FAILED'
      ? 'Partner outcome disputed'
      : 'Needs review · funds reserved';
  }
  if (status === 'COMPLETED') return 'Complete';
  if (status === 'FAILED') return 'Failed · funds returned';
  if (status === 'REJECTED') return 'Not sent';
  return 'Processing';
}

function reconciliationDetails(transfer: AccountActivity): string | null {
  if (!transfer.reconciliationRequired || !transfer.partnerReconciliation) return null;
  const review = transfer.partnerReconciliation;
  if (review.reasonCode === 'CONFLICTING_TERMINAL_OUTCOMES') {
    return `Partner reports conflict: ${review.firstStatus} and ${review.latestStatus}.`;
  }
  if (review.reasonCode === 'PARTNER_FAILURE_REQUIRES_REVIEW') {
    return `Partner reported ${review.firstStatus}; latest report is ${review.latestStatus}. Funds remain reserved while Banku reviews the outcome.`;
  }
  if (review.reasonCode === 'PARTNER_NOT_FOUND_AFTER_SEND') {
    return `Partner lookup found no payout after a possible send; latest report is ${review.latestStatus}. Funds remain reserved.`;
  }
  return 'Banku is reconciling the partner outcome; funds remain reserved.';
}

function titleFor(transfer: AccountActivity): string {
  if (transfer.direction === 'INTERNAL') return 'Between your accounts';
  const counterparty = transfer.counterpartyName || 'Banku account';
  if (transfer.partnerBank) {
    const bank = partnerBanks.find((option) => option.code === transfer.partnerBank)?.name ?? 'Partner bank';
    return `${transfer.direction === 'INCOMING' ? 'From' : 'To'} ${counterparty} · ${bank}`;
  }
  return `${transfer.direction === 'INCOMING' ? 'From' : 'To'} ${counterparty}`;
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function ActivityList({
  items,
  onRetry,
  retryingId,
}: {
  items: AccountActivity[];
  onRetry?: (transferId: string) => void;
  retryingId?: string | null;
}) {
  if (items.length === 0) {
    return <div className="activity-empty"><strong>No transfers yet</strong><p>Sent and received money will appear here.</p></div>;
  }

  return (
    <ul className="activity-list">
      {items.map((transfer) => {
        const completed = transfer.status === 'COMPLETED';
        const failed = transfer.status === 'FAILED' || transfer.status === 'REJECTED';
        const amountSign = completed ? (transfer.direction === 'INCOMING' ? '+' : transfer.direction === 'OUTGOING' ? '−' : '') : '';
        const reference = transfer.providerReference || transfer.id;
        const canRetry = !transfer.reconciliationRequired && ['FAILED', 'REJECTED'].includes(transfer.status) && transfer.transferType === 'CUSTOMER_TO_PARTNER_BANK';
        return (
          <li className="activity-item" key={transfer.id}>
            <span className={`activity-direction ${transfer.direction.toLowerCase()}`} aria-hidden="true">
              {transfer.direction === 'INCOMING' ? '↓' : transfer.direction === 'OUTGOING' ? '↑' : '↔'}
            </span>
            <div className="activity-main">
              <strong>{titleFor(transfer)}</strong>
              {transfer.accountLabel && <span>{transfer.direction === 'INTERNAL' ? transfer.accountLabel : `${transfer.direction === 'INCOMING' ? 'Into' : 'From'} ${transfer.accountLabel}`}</span>}
              <span>{shortDate(transfer.createdAt)}</span>
              {reconciliationDetails(transfer) && <span className="activity-review-detail">{reconciliationDetails(transfer)}</span>}
              <code className="activity-reference">Reference: {reference}</code>
            </div>
            <div className="activity-result">
              <strong className={completed ? (transfer.direction === 'INCOMING' ? 'money-in' : 'money-out') : ''}>
                {amountSign}{money(transfer.amountMinor, transfer.currency)}
              </strong>
              <span className={`activity-status ${transfer.reconciliationRequired ? 'review' : failed ? 'failed' : completed ? 'complete' : 'pending'}`}>
                {statusLabel(transfer.status, transfer.reconciliationRequired)}
              </span>
              {canRetry && onRetry && <button className="activity-retry" type="button" onClick={() => onRetry(transfer.id)} disabled={retryingId === transfer.id}>
                {retryingId === transfer.id ? 'Starting…' : 'Try again'}
              </button>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
