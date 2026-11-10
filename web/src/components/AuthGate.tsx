import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { sendMagicLink, signInWithGoogle } from '../auth';
import { SupremeMark } from './CompanyLogo';

export function AuthLoading() {
  return (
    <main className="auth-shell auth-loading" aria-label="Loading Supreme">
      <span className="auth-mark"><SupremeMark size={27} /></span>
    </main>
  );
}

export function AuthGate() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'google' | 'email' | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [showEmail, setShowEmail] = useState(false);
  // The Google callback completes asynchronously over a deep link, long after
  // signInWithGoogle() has resolved. When that exchange fails it lands on the
  // auth state, not this component's local error — pick it up so a stuck
  // "Opening Google…" button recovers and shows why.
  const authError = useApp().authError;
  useEffect(() => { if (authError) setBusy(null); }, [authError]);
  const shownError = error || authError || '';

  const google = async () => {
    setBusy('google');
    setError('');
    try { await signInWithGoogle(); }
    catch (reason) { setError((reason as Error).message); setBusy(null); }
  };

  const magicLink = async (event: React.FormEvent) => {
    event.preventDefault();
    const clean = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(clean)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy('email');
    setError('');
    try { await sendMagicLink(clean); setSent(true); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <main className="auth-shell">
      <section className="onboarding-window auth-window">
        <header className="onboarding-titlebar"><span>Supreme</span></header>
        <div className="auth-stage">
          <section className="auth-card" aria-labelledby="auth-title">
            {sent ? (
              <div className="auth-inbox" role="status">
                <SupremeMark size={27} />
                <h1 id="auth-title">Check your inbox</h1>
                <p>Open the sign-in link sent to <strong>{email.trim()}</strong> on this Mac.</p>
                <button type="button" onClick={() => { setSent(false); setError(''); }}>Use a different email</button>
              </div>
            ) : (
              <>
                <SupremeMark size={27} />
                <h1 id="auth-title">Sign in to Supreme</h1>
                <button className="auth-google" type="button" disabled={busy !== null} onClick={google}>
                  <span>G</span>{busy === 'google' ? 'Opening Google…' : 'Continue with Google'}
                </button>
                {showEmail ? (
                  <form onSubmit={magicLink}>
                    <label htmlFor="auth-email">Email address</label>
                    <input
                      id="auth-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      placeholder="you@example.com"
                      disabled={busy !== null}
                      onChange={(event) => { setEmail(event.target.value); setError(''); }}
                    />
                    <button className="auth-email-button" type="submit" disabled={busy !== null}>
                      {busy === 'email' ? 'Sending link…' : 'Send sign-in link'}
                    </button>
                  </form>
                ) : (
                  <button className="auth-email-toggle" type="button" onClick={() => setShowEmail(true)}>Use email instead</button>
                )}
                {shownError ? <small className="auth-error" role="alert">{shownError}</small> : null}
              </>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
