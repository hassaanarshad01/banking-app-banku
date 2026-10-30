import { useNavigate } from 'react-router';
import { AuthForm } from '../components/AuthForm';
import { AuthLayout } from '../components/AuthLayout';
import { useAuth } from '../context/useAuth';

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();

  async function handleSignup(fullName: string, phoneNumber: string, email: string, password: string, dateOfBirth: string) {
    await signup(fullName, phoneNumber, email, password, dateOfBirth);
    navigate('/dashboard', { replace: true });
  }

  return <AuthLayout><AuthForm mode="signup" onSubmit={handleSignup} /></AuthLayout>;
}
