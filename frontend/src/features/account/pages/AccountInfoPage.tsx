import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../../shared/api/api-client';
import { BankuHeader } from '../../../shared/components/BankuHeader';
import { useAuth } from '../../auth/context/useAuth';
import './account-info.css';

function formatMoney(minor: string, currency: string): string {
  const value = BigInt(minor);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${(value / 100n).toLocaleString('en-US')}.${(value % 100n).toString().padStart(2, '0')}`;
}

function formatDate(value: string | null): string {
  if (!value) return 'Not provided';
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

export function AccountInfoPage() {
  const { user, updateProfile } = useAuth();
  const [copiedAccountId, setCopiedAccountId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState('');
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phoneNumber, setPhoneNumber] = useState(user?.phoneNumber ?? '');
  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileMessage, setProfileMessage] = useState('');

  useEffect(() => {
    setFullName(user?.fullName ?? '');
    setEmail(user?.email ?? '');
    setPhoneNumber(user?.phoneNumber ?? '');
  }, [user?.fullName, user?.email, user?.phoneNumber]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setProfileError('');
    setProfileMessage('');
    try {
      await updateProfile({ fullName, email, phoneNumber });
      setEditing(false);
      setProfileMessage('Your profile was updated.');
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setProfileError(code === 'EMAIL_ALREADY_REGISTERED'
        ? 'That email is already used by another account.'
        : code === 'PHONE_ALREADY_REGISTERED'
          ? 'That phone number is already used by another account.'
          : code === 'INVALID_REQUEST'
            ? 'Check the name, email, and phone number, then try again.'
            : 'Could not save your profile. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    setFullName(user?.fullName ?? '');
    setEmail(user?.email ?? '');
    setPhoneNumber(user?.phoneNumber ?? '');
    setProfileError('');
    setProfileMessage('');
    setEditing(false);
  }

  async function copyAccountId(accountId: string) {
    try {
      await navigator.clipboard.writeText(accountId);
      setCopiedAccountId(accountId);
      setCopyError('');
      window.setTimeout(() => setCopiedAccountId(null), 1_800);
    } catch {
      setCopyError('Could not copy the account reference.');
    }
  }

  return (
    <main className="account-page-shell">
      <BankuHeader />
      <section className="account-page-content">
        <p className="account-page-eyebrow">YOUR PROFILE</p>
        <h1>Account information</h1>
        <p className="account-page-intro">Your personal details and Banku account references.</p>

        <section className="account-info-panel" aria-labelledby="personal-details-title">
          <div className="account-info-panel-heading">
            <div><p className="account-page-eyebrow">PROFILE</p><h2 id="personal-details-title">Personal details</h2></div>
            <div className="account-profile-heading-actions">
              <span className="account-verified">Signed in</span>
              {!editing && <button className="account-edit-button" type="button" onClick={() => { setProfileMessage(''); setEditing(true); }}>Edit details</button>}
            </div>
          </div>
          {editing ? <form className="account-profile-form" onSubmit={saveProfile}>
            <label htmlFor="profile-full-name">Full name</label>
            <input id="profile-full-name" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120} required />
            <label htmlFor="profile-email">Email address</label>
            <input id="profile-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required />
            <label htmlFor="profile-phone">Phone number <span>(optional)</span></label>
            <input id="profile-phone" type="tel" autoComplete="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} maxLength={64} />
            <p className="account-profile-note">Email changes take effect immediately in this learning project; email verification is not enabled.</p>
            {profileError && <p className="account-copy-error" role="alert">{profileError}</p>}
            <div className="account-profile-actions">
              <button className="account-save-button" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
              <button className="account-cancel-button" type="button" onClick={cancelEdit} disabled={saving}>Cancel</button>
            </div>
          </form> : <>
            <dl className="account-info-grid">
              <div><dt>Full name</dt><dd>{user?.fullName || 'Not provided'}</dd></div>
              <div><dt>Email address</dt><dd>{user?.email || 'Not provided'}</dd></div>
              <div><dt>Phone number</dt><dd>{user?.phoneNumber || 'Not provided'}</dd></div>
              <div><dt>Date of birth</dt><dd>{formatDate(user?.dateOfBirth ?? null)}</dd></div>
              <div><dt>Customer since</dt><dd>{formatDate(user?.createdAt ?? null)}</dd></div>
              <div><dt>Customer reference</dt><dd><code>{user?.id}</code></dd></div>
            </dl>
            <p className="account-info-footnote">Date of birth and customer reference are read-only.</p>
            {profileMessage && <p className="account-profile-success" role="status">{profileMessage}</p>}
          </>}
        </section>

        <section className="account-info-panel" aria-labelledby="bank-accounts-title">
          <div className="account-info-panel-heading"><div><p className="account-page-eyebrow">BANKU ACCOUNTS</p><h2 id="bank-accounts-title">Your accounts</h2></div></div>
          {user?.accounts.length ? user.accounts.map((account) => (
            <article className="account-detail-card" key={account.id}>
              <div className="account-detail-top">
                <div><strong>{account.label || `Banku ${account.currency} account`}</strong><span>{account.currency} · Personal account</span></div>
                <span className={`account-status ${account.status.toLowerCase()}`}>{account.status.toLowerCase()}</span>
              </div>
              <div className="account-detail-balances">
                <div><span>Available</span><strong>{formatMoney(account.availableBalanceMinor, account.currency)}</strong></div>
                <div><span>Reserved</span><strong>{formatMoney(account.lockedBalanceMinor, account.currency)}</strong></div>
              </div>
              <div className="account-reference-row">
                <span>Account reference</span>
                <code>{account.id}</code>
                <button type="button" onClick={() => void copyAccountId(account.id)}>{copiedAccountId === account.id ? 'Copied' : 'Copy'}</button>
              </div>
              <p className="account-info-footnote">Opened {formatDate(account.createdAt)}. This is an internal Banku reference, not a bank routing number.</p>
            </article>
          )) : <p className="account-info-footnote">No accounts are currently attached to this profile.</p>}
          {copyError && <p className="account-copy-error" role="alert">{copyError}</p>}
        </section>
      </section>
    </main>
  );
}
