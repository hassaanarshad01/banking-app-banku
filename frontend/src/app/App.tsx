import { Navigate, Route, Routes } from 'react-router';
import { LoginPage } from '../features/auth/pages/LoginPage';
import { SignupPage } from '../features/auth/pages/SignupPage';
import { DashboardPage } from '../features/dashboard/pages/DashboardPage';
import { TransferPage } from '../features/transfers/pages/TransferPage';
import { ActivityPage } from '../features/activity/pages/ActivityPage';
import { AccountInfoPage } from '../features/account/pages/AccountInfoPage';
import { MerchantsPage } from '../features/merchants/pages/MerchantsPage';
import { GuestRoute } from '../shared/routes/GuestRoute';
import { ProtectedRoute } from '../shared/routes/ProtectedRoute';

export function App() {
  return (
    <Routes>
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/transfers" element={<TransferPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/account" element={<AccountInfoPage />} />
        <Route path="/merchants" element={<MerchantsPage />} />
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
