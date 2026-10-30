import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../../features/auth/context/useAuth';

export function GuestRoute() {
  const { user, loading } = useAuth();
  if (loading) return <div className="route-loading">Checking your session…</div>;
  return user ? <Navigate to="/dashboard" replace /> : <Outlet />;
}
