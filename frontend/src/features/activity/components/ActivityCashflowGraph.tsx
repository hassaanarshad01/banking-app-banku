import { useEffect, useState } from 'react';
import { ApiError } from '../../../shared/api/api-client';
import { accountTransferApi, type CashflowMonth } from '../../transfers/api/account-transfer-api';
import './activity-graphs.css';

function formatUsd(minorUnits: string): string {
  const minor = BigInt(minorUnits);
  return `$${(minor / 100n).toLocaleString('en-US')}.${(minor % 100n).toString().padStart(2, '0')}`;
}

function monthLabel(value: string): string {
  const [year, month] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year!, month! - 1, 1)));
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'CASHFLOW_GRAPH_UNAVAILABLE';
}

export function ActivityCashflowGraph({ accountId }: { accountId?: string }) {
  const [months, setMonths] = useState<CashflowMonth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const { months: loaded } = await accountTransferApi.cashflow(accountId);
        if (active) setMonths(loaded);
      } catch (caught) {
        if (active) setError(errorCode(caught));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [accountId, attempt]);

  const max = months.reduce((value, month) => {
    const inAmount = BigInt(month.creditsMinor);
    const outAmount = BigInt(month.debitsMinor);
    return [value, inAmount, outAmount].reduce((largest, amount) => amount > largest ? amount : largest, 0n);
  }, 0n);
  const points = months.map((month, index) => {
    const x = months.length < 2 ? 350 : 55 + (index * 590) / (months.length - 1);
    const y = (amount: string) => max === 0n ? 190 : 190 - Number(BigInt(amount) * 140_000n / max) / 1000;
    return { ...month, x, creditY: y(month.creditsMinor), debitY: y(month.debitsMinor) };
  });
  const creditPath = points.map(({ x, creditY }, index) => `${index === 0 ? 'M' : 'L'} ${x} ${creditY}`).join(' ');
  const debitPath = points.map(({ x, debitY }, index) => `${index === 0 ? 'M' : 'L'} ${x} ${debitY}`).join(' ');

  return <section className="activity-graph-card" aria-labelledby="activity-cashflow-title">
    <div className="activity-graph-heading"><div><p className="account-page-eyebrow">MONTHLY OVERVIEW</p><h2 id="activity-cashflow-title">Money in and out</h2></div><span>Last six months · USD</span></div>
    {loading
      ? <p className="activity-graph-state" role="status">Loading cash-flow graph…</p>
      : error
        ? <div className="activity-graph-error" role="alert"><p>Sorry, this graph couldn’t load.</p><code>{error}</code><button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry graph</button></div>
        : months.length === 0 || max === 0n
          ? <p className="activity-graph-state">Completed transfers will appear here.</p>
          : <>
            <div className="activity-graph-legend"><span><i className="received" />Received</span><span><i className="spent" />Spent</span></div>
            <svg className="activity-cashflow-svg" viewBox="0 0 700 245" role="img" aria-label={months.map((month) => `${monthLabel(month.month)} received ${formatUsd(month.creditsMinor)}, spent ${formatUsd(month.debitsMinor)}`).join('. ')}>
              {[50, 96, 143, 190].map((y) => <line key={y} x1="42" y1={y} x2="665" y2={y} className="activity-chart-gridline" />)}
              <path d={creditPath} className="activity-line received-line" />
              <path d={debitPath} className="activity-line spent-line" />
              {points.map((point) => <g key={point.month}>
                <circle cx={point.x} cy={point.creditY} r="4.5" className="activity-dot received-dot"><title>{monthLabel(point.month)} received {formatUsd(point.creditsMinor)}</title></circle>
                <circle cx={point.x} cy={point.debitY} r="4.5" className="activity-dot spent-dot"><title>{monthLabel(point.month)} spent {formatUsd(point.debitsMinor)}</title></circle>
                <text x={point.x} y="220" textAnchor="middle">{monthLabel(point.month)}</text>
              </g>)}
            </svg>
          </>}
  </section>;
}
