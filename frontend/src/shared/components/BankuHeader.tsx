import { useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router';
import { useAuth } from '../../features/auth/context/useAuth';
import './banku-header.css';

export function BankuHeader() {
  const { logout } = useAuth();
  const [searchParams] = useSearchParams();
  const accountId = searchParams.get('accountId');
  const dashboardPath = accountId ? `/dashboard?accountId=${encodeURIComponent(accountId)}` : '/dashboard';
  const activityPath = accountId ? `/activity?accountId=${encodeURIComponent(accountId)}` : '/activity';
  const [error, setError] = useState('');

  async function handleLogout() {
    setError('');
    try {
      await logout();
    } catch {
      setError('Could not sign out. Please try again.');
    }
  }

  return (
    <header className="banku-header">
      <Link className="banku-header-brand" to={dashboardPath}>banku<span>.</span></Link>
      <nav className="banku-header-nav" aria-label="Main navigation">
        <NavLink to={dashboardPath}>Home</NavLink>
        <NavLink to="/transfers">Send money</NavLink>
        <NavLink to={activityPath}>Activity</NavLink>
        <NavLink to="/merchants">Merchants</NavLink>
        <NavLink to="/account">Account</NavLink>
      </nav>
      <button className="banku-header-signout" type="button" onClick={handleLogout}>Sign out</button>
      {error && <p className="banku-header-error" role="alert">{error}</p>}
    </header>
  );
}
