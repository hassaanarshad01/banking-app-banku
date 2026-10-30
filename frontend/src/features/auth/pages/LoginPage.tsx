import { useNavigate } from 'react-router';
import { AuthForm } from '../components/AuthForm';
import { AuthLayout } from '../components/AuthLayout';
import { useAuth } from '../context/useAuth';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleLogin(_fullName: string, _phoneNumber: string, email: string, password: string, _dateOfBirth: string) {
    await login(email, password);
    navigate('/dashboard', { replace: true });
  }

  return <AuthLayout><AuthForm mode="login" onSubmit={handleLogin} /></AuthLayout>;
}
