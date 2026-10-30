import type { AccountActivitySummary } from '../../transfers/api/account-transfer-api';

const palette = {
  debits: '#b98a61',
  credits: '#63866c',
  people: '#63866c',
  businesses: '#a6ad71',
  partners: '#c38b5b',
  other: '#9caaa0',
};

const categoryLabels = {
  PEOPLE: 'People',
  BUSINESSES: 'Businesses',
  PARTNER_BANKS: 'Partner banks',
  OTHER: 'Other',
} as const;

function formatUsd(minorUnits: string): string {
  const minor = BigInt(minorUnits);
  return `$${(minor / 100n).toLocaleString('en-US')}.${(minor % 100n).toString().padStart(2, '0')}`;
}

function formatMonth(value: string): string {
  const [year, month] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year!, month! - 1, 1)));
}

function scaled(value: string, max: bigint, height: number): number {
  if (max === 0n) return 0;
  return Number(BigInt(value) * BigInt(height * 1000) / max) / 1000;
}

export function AccountInsights({ summary }: { summary: AccountActivitySummary }) {
  const totalDebits = summary.months.reduce((sum, month) => sum + BigInt(month.debitsMinor), 0n);
  const totalCredits = summary.months.reduce((sum, month) => sum + BigInt(month.creditsMinor), 0n);
  const maxMonthly = summary.months.reduce((max, month) => {
    const debit = BigInt(month.debitsMinor);
    const credit = BigInt(month.creditsMinor);
    return debit > max ? (credit > debit ? credit : debit) : credit > max ? credit : max;
  }, 0n);
  const mixTotal = summary.debitMix.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n);
  const categoryColors = {
    PEOPLE: palette.people,
    BUSINESSES: palette.businesses,
    PARTNER_BANKS: palette.partners,
    OTHER: palette.other,
  };
  let angle = 0;
  const slices = summary.debitMix.map((item, index) => {
    const start = angle;
    const amount = BigInt(item.amountMinor);
    angle = index === summary.debitMix.length - 1
      ? 100
      : angle + (mixTotal > 0n ? Number(amount * 10_000n / mixTotal) / 100 : 0);
    return `${categoryColors[item.category]} ${start}% ${angle}%`;
  });
  const donutStyle = {
    background: mixTotal > 0n ? `conic-gradient(${slices.join(', ')})` : '#e8ece6',
  };

  return <section className="dashboard-insights" aria-label="Account activity summary">
    <div className="dashboard-insights-heading">
      <div><p className="dashboard-eyebrow">YOUR CASH FLOW</p><h2>Six-month overview</h2></div>
      <span>Completed activity · USD</span>
    </div>
    <div className="dashboard-insights-totals">
      <div><span>Total in</span><strong>{formatUsd(totalCredits.toString())}</strong></div>
      <div><span>Total out</span><strong>{formatUsd(totalDebits.toString())}</strong></div>
      <div><span>Net flow</span><strong className={totalCredits >= totalDebits ? 'positive' : 'negative'}>{totalCredits >= totalDebits ? '+' : '−'}{formatUsd((totalCredits >= totalDebits ? totalCredits - totalDebits : totalDebits - totalCredits).toString())}</strong></div>
    </div>
    <div className="dashboard-chart-grid">
      <article className="dashboard-chart-card">
        <div className="dashboard-chart-title"><h3>Money in and out</h3><div className="dashboard-chart-legend"><span><i className="credits" />In</span><span><i className="debits" />Out</span></div></div>
        {summary.months.every((month) => BigInt(month.debitsMinor) === 0n && BigInt(month.creditsMinor) === 0n)
          ? <p className="dashboard-chart-empty">Completed transfers will appear here.</p>
          : <svg className="dashboard-cashflow-chart" viewBox="0 0 600 180" role="img" aria-label="Monthly completed credits and debits for the past six months">
            <line x1="26" y1="139" x2="578" y2="139" />
            {summary.months.map((month, index) => {
              const center = 65 + index * 94;
              const debitHeight = scaled(month.debitsMinor, maxMonthly, 105);
              const creditHeight = scaled(month.creditsMinor, maxMonthly, 105);
              return <g key={month.month}>
                <rect className="cashflow-credit" x={center - 18} y={139 - creditHeight} width="16" height={creditHeight} rx="4" />
                <rect className="cashflow-debit" x={center + 3} y={139 - debitHeight} width="16" height={debitHeight} rx="4" />
                <text x={center + 2} y="163" textAnchor="middle">{formatMonth(month.month)}</text>
              </g>;
            })}
          </svg>}
      </article>
      <article className="dashboard-chart-card">
        <div className="dashboard-chart-title"><h3>Where money went</h3><span>Debit mix</span></div>
        <div className="dashboard-debit-mix">
          <div className="dashboard-donut" style={donutStyle} role="img" aria-label={`Debit mix totaling ${formatUsd(mixTotal.toString())}`}>
            <div><strong>{formatUsd(mixTotal.toString())}</strong><span>Total out</span></div>
          </div>
          <ul>{summary.debitMix.map((item) => <li key={item.category}>
            <span><i style={{ backgroundColor: categoryColors[item.category] }} />{categoryLabels[item.category]}</span>
            <strong>{formatUsd(item.amountMinor)}</strong>
          </li>)}</ul>
        </div>
        {summary.debitMix.length === 0 && <p className="dashboard-chart-empty">Your completed payments will be grouped here.</p>}
      </article>
    </div>
  </section>;
}
