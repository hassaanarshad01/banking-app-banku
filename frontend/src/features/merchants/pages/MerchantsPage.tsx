import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../../shared/api/api-client';
import { BankuHeader } from '../../../shared/components/BankuHeader';
import { useAuth } from '../../auth/context/useAuth';
import { merchantApi, type Merchant } from '../api/merchant-api';
import './merchants.css';

function formatUsd(minorUnits: string): string {
  const minor = BigInt(minorUnits);
  return `$${(minor / 100n).toLocaleString('en-US')}.${(minor % 100n).toString().padStart(2, '0')}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value));
}

export function MerchantsPage() {
  const { refresh } = useAuth();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let active = true;
    let loadingRequest = false;
    let initialLoad = true;
    const load = async () => {
      if (loadingRequest) return;
      loadingRequest = true;
      try {
        const { merchants: loaded } = await merchantApi.list();
        if (active) { setMerchants(loaded); setLoadError(''); }
      } catch {
        if (active && initialLoad) setLoadError('Could not load your merchant accounts. Try again.');
      } finally {
        loadingRequest = false;
        initialLoad = false;
        if (active) setLoading(false);
      }
    };
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void load(); };
    void load();
    const timer = window.setInterval(refreshWhenVisible, 3_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refreshWhenVisible); document.removeEventListener('visibilitychange', refreshWhenVisible); };
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    setFormMessage('');
    try {
      const response = await merchantApi.create({ displayName: displayName.trim(), handle: handle.trim().toLowerCase() });
      setMerchants((current) => [...current, response.merchant]);
      setDisplayName('');
      setHandle('');
      setFormMessage(`${response.merchant.displayName} merchant account is ready.`);
      await refresh().catch(() => {});
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setFormError(code === 'MERCHANT_HANDLE_TAKEN'
        ? 'That merchant handle is already in use.'
        : code === 'INVALID_REQUEST'
          ? 'Use a 2–120 character business name and a 3–32 character handle with at least one letter.'
          : 'Could not create the merchant account. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(''), 1_800);
    } catch {
      setFormError('Could not copy to clipboard.');
    }
  }

  return (
    <main className="merchants-shell">
      <BankuHeader />
      <div className="merchants-content">
        <section className="merchants-intro">
          <p className="merchants-eyebrow">BANKU FOR BUSINESS</p>
          <h1>Merchant accounts.</h1>
          <p>Create a business account, share its handle, and manage its Banku balance separately from your personal money.</p>
        </section>

        <div className="merchants-layout">
          <section className="merchant-panel merchant-create-panel" aria-labelledby="create-merchant-title">
            <p className="merchants-eyebrow">GET STARTED</p>
            <h2 id="create-merchant-title">Set up a merchant</h2>
            <p className="merchant-panel-copy">Your USD merchant account is created with you as its owner.</p>
            <form className="merchant-form" onSubmit={create}>
              <label htmlFor="merchant-name">Business name</label>
              <input id="merchant-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} autoComplete="organization" placeholder="Northstar Market" required />
              <label htmlFor="merchant-handle">Merchant handle</label>
              <div className="merchant-handle-input"><span aria-hidden="true">@</span><input id="merchant-handle" value={handle} onChange={(event) => setHandle(event.target.value.toLowerCase().replace(/\s+/g, '-'))} minLength={3} maxLength={32} pattern="(?=.*[a-z])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="northstar-market" required /></div>
              <p className="merchant-field-hint">Letters, numbers, and hyphens. Customers can find you by this handle.</p>
              {formError && <p className="merchant-error" role="alert">{formError}</p>}
              {formMessage && <p className="merchant-success" role="status">{formMessage}</p>}
              <button className="merchant-primary" type="submit" disabled={saving}>{saving ? 'Creating account…' : 'Create merchant account'} <span aria-hidden="true">→</span></button>
            </form>
          </section>

          <section className="merchant-list-panel" aria-labelledby="merchant-accounts-title">
            <div className="merchant-list-heading">
              <div><p className="merchants-eyebrow">YOUR BUSINESSES</p><h2 id="merchant-accounts-title">Merchant accounts</h2></div>
              <span className="merchant-count">{merchants.length}</span>
            </div>
            {loading
              ? <p className="merchant-state-message">Loading merchant accounts…</p>
              : loadError
                ? <p className="merchant-state-message" role="alert">{loadError}</p>
                : merchants.length === 0
                  ? <div className="merchant-empty"><span aria-hidden="true">↗</span><strong>No merchant accounts yet</strong><p>Create your first business account to get started.</p></div>
                  : <div className="merchant-cards">{merchants.map((merchant) => (
                    <article className="merchant-account-card" key={merchant.id}>
                      <div className="merchant-account-heading">
                        <div><p className="merchants-eyebrow">{merchant.role}</p><h3>{merchant.displayName}</h3></div>
                        <span className={`merchant-status ${merchant.status.toLowerCase()}`}>{merchant.status.toLowerCase()}</span>
                      </div>
                      <p className="merchant-handle-display">@{merchant.handle}</p>
                      <div className="merchant-balance-block">
                        <span>Available balance · USD</span>
                        <strong>{merchant.account ? formatUsd(merchant.account.availableBalanceMinor) : '$0.00'}</strong>
                        {merchant.account && BigInt(merchant.account.pendingCreditsMinor ?? '0') > 0n && <small>Incoming credits pending · {formatUsd(merchant.account.pendingCreditsMinor!)}</small>}
                        <small>Reserved {merchant.account ? formatUsd(merchant.account.lockedBalanceMinor) : '$0.00'}</small>
                      </div>
                      {merchant.account && <div className="merchant-reference">
                        <span>Account reference</span>
                        <code>{merchant.account.id}</code>
                        <button type="button" onClick={() => void copyValue(merchant.account!.id, merchant.id)}>{copied === merchant.id ? 'Copied' : 'Copy'}</button>
                      </div>}
                      <p className="merchant-created-date">Opened {formatDate(merchant.createdAt)}</p>
                      <div className="merchant-card-actions">
                        <button type="button" onClick={() => void copyValue(`@${merchant.handle}`, `handle:${merchant.id}`)}>{copied === `handle:${merchant.id}` ? 'Handle copied' : 'Copy payment handle'}</button>
                        {merchant.account && <Link to={`/transfers?from=${encodeURIComponent(merchant.account.id)}`}>Send from this account <span aria-hidden="true">→</span></Link>}
                      </div>
                    </article>
                  ))}</div>}
          </section>
        </div>

        <aside className="merchant-projection-note">
          <span aria-hidden="true">i</span>
          <p>Incoming merchant payments are recorded immediately. Available balance may take a moment to refresh while credits are batched.</p>
        </aside>
        <Link className="merchant-back-link" to="/dashboard">← Back to your Banku home</Link>
      </div>
    </main>
  );
}
