import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../../shared/api/api-client';
import type { AuthMode } from '../types';

function latestAdultBirthDate(): string {
  const today = new Date();
  return new Date(Date.UTC(
    today.getUTCFullYear() - 18,
    today.getUTCMonth(),
    today.getUTCDate(),
  )).toISOString().slice(0, 10);
}

type AuthFormProps = {
  mode: AuthMode;
  onSubmit(fullName: string, phoneNumber: string, email: string, password: string, dateOfBirth: string): Promise<void>;
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      EMAIL_ALREADY_REGISTERED: 'An account with this email already exists.',
      PHONE_ALREADY_REGISTERED: 'An account with this phone number already exists.',
      INVALID_CREDENTIALS: 'Email or password is incorrect.',
      INVALID_REQUEST: 'Check your email and password, then try again.',
      TOO_MANY_ATTEMPTS: 'Too many attempts. Wait a while and try again.',
      UNDER_18: 'You must be at least 18 years old to create an account.',
      BONUS_UNAVAILABLE: 'Signup funds are temporarily unavailable. Please try again later.',
    };
    return messages[error.code] ?? 'Something went wrong. Try again.';
  }
  return 'Could not reach the Banku API. Is it running?';
}

export function AuthForm({ mode, onSubmit }: AuthFormProps) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [password, setPassword] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isSignup = mode === 'signup';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit(isSignup ? fullName : '', isSignup ? phoneNumber : '', email, password, isSignup ? dateOfBirth : '');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-content">
      <p className="eyebrow dark-eyebrow">{isSignup ? 'A GOOD PLACE TO BEGIN' : 'GOOD TO HAVE YOU BACK'}</p>
      <h2>{isSignup ? 'Create your account.' : 'Welcome back.'}</h2>
      <p className="form-intro">
        {isSignup ? 'A few details and you’re ready to get started.' : 'Sign in to continue to your Banku account.'}
      </p>

      <div className="mode-switch" aria-label="Choose sign in or sign up">
        <Link to="/login" className={!isSignup ? 'active' : ''} aria-current={!isSignup ? 'page' : undefined}>Sign in</Link>
        <Link to="/signup" className={isSignup ? 'active' : ''} aria-current={isSignup ? 'page' : undefined}>Create account</Link>
      </div>

      {isSignup && <aside className="signup-bonus-note">
        <span aria-hidden="true">+$100</span>
        <p><strong>A little head start.</strong> Complete signup to receive $100.00 USD in your Banku account.</p>
      </aside>}

      <form onSubmit={handleSubmit}>
        {isSignup && <>
          <label htmlFor="fullName">Full name</label>
          <input
            id="fullName"
            name="fullName"
            type="text"
            autoComplete="name"
            placeholder="Your full name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            maxLength={120}
            required
          />

          <label htmlFor="phoneNumber">Phone number</label>
          <input
            id="phoneNumber"
            name="phoneNumber"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="Your phone number"
            value={phoneNumber}
            onChange={(event) => setPhoneNumber(event.target.value)}
            maxLength={64}
            required
          />
        </>}

        <label htmlFor="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          maxLength={254}
          required
        />

        {isSignup && <>
          <label htmlFor="dateOfBirth">Date of birth</label>
          <input
            id="dateOfBirth"
            name="dateOfBirth"
            type="date"
            autoComplete="bday"
            value={dateOfBirth}
            onChange={(event) => setDateOfBirth(event.target.value)}
            max={latestAdultBirthDate()}
            required
          />
        </>}

        <div className="password-label-row">
          <label htmlFor="password">Password</label>
          {isSignup && <span>12 characters minimum</span>}
        </div>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          placeholder={isSignup ? 'Create a strong password' : 'Enter your password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={isSignup ? 12 : undefined}
          maxLength={128}
          required
        />

        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="submit-button" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in securely'}
          <span aria-hidden="true">↗</span>
        </button>
      </form>

      <p className="terms-note">Your password is hashed before it is stored. Session tokens stay in a protected, HTTP-only cookie.</p>
    </div>
  );
}
