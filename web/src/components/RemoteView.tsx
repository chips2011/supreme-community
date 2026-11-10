import { useState } from 'react';
import { useApp } from '../store';
import { Icon } from '../icons';
import { relativeTime } from '../lib/format';
import { loadRemote, requestTestFlight } from '../actions';
import type { TestFlightInviteResult } from '../actions';
import type { RemoteSnapshot } from '../types';
import { signOutAccount } from '../auth';

function TestFlightState() {
  const s = useApp();
  const [email, setEmail] = useState(() => s.user?.email || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<TestFlightInviteResult | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(clean)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const invitation = await requestTestFlight(clean);
      setResult(invitation);
      if (invitation.status === 'connected') await loadRemote({ quiet: true });
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="remote-state remote-install-state">
      <span className="remote-state-mark"><Icon name="smartphone" size={23} /></span>
      <h1>Get Supreme on your iPhone</h1>
      <p>Apple will email you a private TestFlight invitation.</p>
      {result ? (
        <div className="remote-link-ready" role="status">
          <span><Icon name="check" size={12} /></span>
          <div>
            <b>{result.status === 'connected'
              ? 'Your iPhone is connected'
              : result.status === 'already-invited' || ['ACCEPTED', 'INSTALLED'].includes(result.testerState || '')
                ? 'You’re already in TestFlight'
                : result.url ? 'Your link is ready' : 'Check your inbox'}</b>
            <small>{result.status === 'connected'
              ? 'Supreme is already paired with this account.'
              : result.status === 'already-invited' || ['ACCEPTED', 'INSTALLED'].includes(result.testerState || '')
                ? 'Open TestFlight on your iPhone to install or update Supreme.'
                : result.url
                  ? 'Open TestFlight on your iPhone to install Supreme.'
                  : `Apple sent the invitation to ${result.email}.`}</small>
          </div>
          {result.url
            ? <a href={result.url} target="_blank" rel="noreferrer">Open TestFlight</a>
            : result.status !== 'connected'
              ? <button type="button" onClick={() => setResult(null)}>Send again</button>
              : null}
        </div>
      ) : (
        <form className="remote-testflight-form" onSubmit={submit}>
          <label htmlFor="remote-email">Email for TestFlight</label>
          <div>
            <input
              id="remote-email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              disabled={busy}
              onChange={(event) => { setEmail(event.target.value); setError(''); }}
            />
            <button type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send invite'}</button>
          </div>
          {error ? <small className="remote-form-error" role="alert">{error}</small> : null}
          {!error ? <small className="remote-form-note">Use the email address on your Supreme account.</small> : null}
        </form>
      )}
    </section>
  );
}

function MobileLiveState({
  app,
  machine,
  activeCount,
}: {
  app: RemoteSnapshot['mobileApp'];
  machine: RemoteSnapshot['machine'];
  activeCount: number;
}) {
  const deviceName = app.deviceName || 'iPhone';
  const lastSeen = app.lastSeen ? relativeTime(app.lastSeen) : 'recently';
  const appStatus = app.live ? 'Live now' : `Last seen ${lastSeen}`;
  const machineStatus = machine?.online ? `${machine.name} online` : 'Mac not reachable';
  const workStatus = activeCount ? `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'} running` : 'Nothing running';

  return (
    <section className="remote-state remote-live-state">
      <div className="remote-live-head">
        <span className={`remote-live-mark ${app.live ? 'online' : ''}`}><Icon name="smartphone" size={22} /></span>
        <div>
          <h1>{app.live ? 'Supreme is connected' : 'Supreme is on your iPhone'}</h1>
          <p>{app.live ? `${deviceName} is live now.` : `${deviceName} was last seen ${lastSeen}.`}</p>
        </div>
        <span className={`remote-live-badge ${app.live ? 'online' : ''}`}><i />{app.live ? 'Live' : 'Offline'}</span>
      </div>
      <dl className="remote-live-details">
        <div><dt>iPhone app</dt><dd>{appStatus}{app.appVersion ? ` · ${app.appVersion}` : ''}</dd></div>
        <div><dt>Mac</dt><dd>{machineStatus}</dd></div>
        <div><dt>Current work</dt><dd>{workStatus}</dd></div>
      </dl>
    </section>
  );
}

export function RemoteView() {
  const s = useApp();
  const app = s.remote.mobileApp;
  return (
    <div className="remote-page">
      <header className="remote-top">
        <div className="remote-brand"><span><Icon name="smartphone" size={17} /></span><b>Remote</b></div>
        <button className="remote-refresh" aria-label="Refresh status" onClick={() => loadRemote()}><Icon name="refresh" size={15} /></button>
        {s.authConfigured ? <button className="remote-refresh remote-account" aria-label="Sign out" title={s.user?.email || 'Sign out'} onClick={() => void signOutAccount()}><Icon name="user" size={15} /></button> : null}
      </header>
      <main className="remote-body">
        {s.remote.loading && !app ? (
          <div className="remote-loading"><span className="spin" /> Checking your iPhone…</div>
        ) : app?.installed ? (
          <MobileLiveState app={app} machine={s.remote.machine} activeCount={s.remote.activeCount} />
        ) : <TestFlightState />}
      </main>
    </div>
  );
}
