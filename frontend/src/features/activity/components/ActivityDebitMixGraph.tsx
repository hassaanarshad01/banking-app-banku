import { useEffect, useState } from 'react';
import { ApiError } from '../../../shared/api/api-client';
import { accountTransferApi, type DebitMixItem } from '../../transfers/api/account-transfer-api';
import './activity-graphs.css';

const labels: Record<DebitMixItem['category'], string> = {
  PEOPLE: 'People',
  BUSINESSES: 'Businesses',
  PARTNER_BANKS: 'Partner banks',
  OTHER: 'Other',
};
const colors: Record<DebitMixItem['category'], string> = {
  PEOPLE: '#63866c',
  BUSINESSES: '#a6ad71',
  PARTNER_BANKS: '#d4b334',
  OTHER: '#9caaa0',
};

function formatUsd(minorUnits: string): string {
  const minor = BigInt(minorUnits);
  return `$${(minor / 100n).toLocaleString('en-US')}.${(minor % 100n).toString().padStart(2, '0')}`;
}

export function ActivityDebitMixGraph({ accountId }: { accountId?: string }) {
  const [items, setItems] = useState<DebitMixItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const { debitMix } = await accountTransferApi.debitMix(accountId);
        if (active) setItems(debitMix);
      } catch (caught) {
        if (active) setError(caught instanceof ApiError ? caught.code : 'DEBIT_MIX_GRAPH_UNAVAILABLE');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [accountId, attempt]);

  const total = items.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n);
  let percent = 0;
  const slices = items.map((item, index) => {
    const start = percent;
    percent = index === items.length - 1
      ? 100
      : percent + (total > 0n ? Number(BigInt(item.amountMinor) * 10_000n / total) / 100 : 0);
    return `${colors[item.category]} ${start}% ${percent}%`;
  });

  return <section className="activity-graph-card" aria-labelledby="activity-debit-mix-title">
    <div className="activity-graph-heading"><div><p className="account-page-eyebrow">SPENDING BREAKDOWN</p><h2 id="activity-debit-mix-title">Where money went</h2></div><span>Last six months · USD</span></div>
    {loading
      ? <p className="activity-graph-state" role="status">Loading spending graph…</p>
      : error
        ? <div className="activity-graph-error" role="alert"><p>Sorry, this graph couldn’t load.</p><code>{error}</code><button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry graph</button></div>
        : items.length === 0
          ? <p className="activity-graph-state">Completed payments will appear here.</p>
          : <div className="activity-debit-mix">
            <div className="activity-debit-donut" style={{ background: `conic-gradient(${slices.join(', ')})` }} role="img" aria-label={`Spending breakdown totaling ${formatUsd(total.toString())}`}>
              <div><strong>{formatUsd(total.toString())}</strong><span>Total spent</span></div>
            </div>
            <ul>{items.map((item) => <li key={item.category}>
              <span><i style={{ backgroundColor: colors[item.category] }} />{labels[item.category]}</span>
              <strong>{formatUsd(item.amountMinor)}</strong>
            </li>)}</ul>
          </div>}
  </section>;
}
