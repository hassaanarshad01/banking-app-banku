import type { ReactNode } from 'react';
import { Link } from 'react-router';
import './auth.css';

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="welcome-panel" aria-label="About Banku">
        <Link className="wordmark" to="/" aria-label="Banku home">
          <span className="brand-mark" aria-hidden="true">b</span>
          banku<span className="wordmark-period">.</span>
        </Link>
        <div className="welcome-copy">
          <span className="eyebrow"><span className="eyebrow-dot" /> YOUR MONEY, IN GOOD ORDER</span>
          <h1>A clearer way<br />to move forward.</h1>
          <p>A thoughtful home for your everyday finances. Simple by design, careful by default.</p>
        </div>
        <div className="panel-footer"><span>BUILT WITH CARE</span><span>01 / 03</span></div>
        <span className="orb orb-one" aria-hidden="true" />
        <span className="orb orb-two" aria-hidden="true" />
      </section>

      <section className="form-panel" aria-label="Account access">
        <div className="form-topline">
          <span className="secure-label"><span className="lock-icon" aria-hidden="true">⌑</span> SECURE ACCOUNT ACCESS</span>
          <span className="step-label">01 <i /> 03</span>
        </div>
        {children}
        <footer className="form-footer"><span>© 2026 BANKU</span><span>PRIVACY <b>·</b> SECURITY</span></footer>
      </section>
    </main>
  );
}
